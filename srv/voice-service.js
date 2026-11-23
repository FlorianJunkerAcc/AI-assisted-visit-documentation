import { createHash } from 'node:crypto'
import cds from '@sap/cds'
import { ok, fail } from './lib/tool-result.js'
import { isValidTimeZone, normaliseLanguage } from './lib/validation.js'
import * as c4c from './lib/c4c-client.js'
import { localDayRangeUtc, localDate, zonedTimeToUtc, formatLocalTime, formatLocalDate } from './lib/time.js'
import { VISIT_STATUS } from './lib/c4c-codes.js'

const LOG = cds.log('voice')
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql

// Session states in which the conversation is finished; no tool may change anything anymore.
const FINAL_STATES = ['COMPLETED', 'PARTIAL_FAILURE', 'FAILED', 'CANCELLED', 'NO_VISIT']

// YES / NO keywords for utterance check in confirmCommit.
const YES_WORDS = ['ja', 'jawohl', 'stimmt', 'korrekt', 'bitte', 'speichern', 'genau', 'ja bitte',
  'yes', 'correct', 'right', 'please', 'save', 'confirm', 'go ahead', 'sure', 'ok', 'okay']
const NO_WORDS = ['nein', 'nicht', 'stop', 'abbruch', 'abbrechen', 'korrigieren', 'ändern', 'falsch',
  'no', 'cancel', 'wrong', 'undo', 'change', 'halt']

function matchesWord (utterance, words) {
  // Replace punctuation with spaces for word boundary detection.
  const clean = utterance.replace(/[.,!?;:'"()-]/g, ' ').replace(/\s+/g, ' ').trim()
  return words.some(w => clean === w || clean.startsWith(w + ' ') || clean.endsWith(' ' + w) || clean.includes(' ' + w + ' '))
}

export default class VoiceAssistantService extends cds.ApplicationService {
  init () {
    const { VoiceSessions, VisitDrafts, TaskDrafts, CommitConfirmations, CommitOperations, AuditLog } = cds.entities('voice')
    const retentionDays = cds.env.voice?.sessionRetentionDays ?? 7

    // --- helpers ------------------------------------------------------------------------------

    /** Writes an audit entry. Metadata only – never conversation content. */
    const audit = (req, event, { sessionId, visitObjectID, outcome, details } = {}) =>
      INSERT.into(AuditLog).entries({
        userId: req.user.id,
        sessionId,
        event,
        c4cVisitObjectID: visitObjectID,
        outcome,
        details: details?.slice(0, 1000)
      })

    /**
     * Loads the session and checks that it belongs to the current user.
     * Sessions of other users are reported as "not found" so that their existence is not revealed.
     */
    this.loadOwnSession = async (req, sessionId, { allowFinal = false } = {}) => {
      if (!sessionId) return req.reject(400, 'SESSION_ID_MISSING')
      const session = await SELECT.one.from(VoiceSessions).where({ ID: sessionId })
      if (!session || session.userId !== req.user.id) return req.reject(404, 'SESSION_NOT_FOUND')
      if (session.expiresAt && new Date(session.expiresAt) < new Date()) return req.reject(410, 'SESSION_EXPIRED')
      if (!allowFinal && FINAL_STATES.includes(session.status)) return req.reject(409, `SESSION_${session.status}`)
      return session
    }

    // --- session ------------------------------------------------------------------------------

    this.on('startSession', async (req) => {
      const { timeZone, language } = req.data
      if (!isValidTimeZone(timeZone)) return req.reject(400, 'INVALID_TIME_ZONE')
      const lang = language ? normaliseLanguage(language) : 'de'
      if (!lang) return req.reject(400, 'UNSUPPORTED_LANGUAGE')

      // NOTE: where XSUAA (SAP ID Service) provides the login e-mail is verified in phase 9.
      const userEmail = req.user.attr?.email ?? null
      if (!userEmail) return fail('USER_EMAIL_MISSING', 'The login provides no e-mail. Tell the user that their account cannot be mapped to SAP Sales Cloud.')

      // The login e-mail must belong to exactly one active C4C employee.
      let employees
      try {
        employees = await c4c.findActiveEmployeesByEmail(userEmail)
      } catch {
        return fail('C4C_UNAVAILABLE', 'SAP Sales Cloud is not reachable. Tell the user to try again later.')
      }
      if (employees.length !== 1) {
        await audit(req, 'SESSION_REJECTED', { outcome: 'USER_NOT_MAPPED', details: `active employees for login e-mail: ${employees.length}` })
        return fail('USER_NOT_IN_C4C', 'The user could not be mapped to exactly one active employee in SAP Sales Cloud. Tell the user and end the conversation.')
      }
      const me = employees[0]

      const ID = cds.utils.uuid()
      const expiresAt = new Date(Date.now() + retentionDays * 24 * 3600 * 1000).toISOString()
      await INSERT.into(VoiceSessions).entries({
        ID,
        userId: req.user.id,
        userEmail,
        c4cEmployeeUUID: me.uuid,
        c4cEmployeeBPID: me.businessPartnerID,
        timeZone,
        language: lang,
        status: 'ACTIVE',
        expiresAt
      })
      await audit(req, 'SESSION_STARTED', { sessionId: ID, outcome: 'OK' })
      LOG.info('session started', { sessionId: ID })

      return ok('SESSION_STARTED', 'Session started. Next: call findVisit.', { sessionId: ID, language: lang })
    })

    this.on('cancelSession', async (req) => {
      const session = await this.loadOwnSession(req, req.data.sessionId)
      if (!session) return
      if (session.status === 'COMMITTING') {
        // C4C writes are already running; they must finish or fail on their own.
        return fail('COMMIT_RUNNING', 'Saving is in progress and cannot be cancelled.')
      }
      await UPDATE(VoiceSessions, session.ID).with({ status: 'CANCELLED' })
      await audit(req, 'SESSION_CANCELLED', { sessionId: session.ID, outcome: 'OK' })
      return ok('SESSION_CANCELLED', 'Session cancelled. Nothing was written to C4C.')
    })

    // --- Visit identification (phase 2) --------------------------------------------------------

    const visitForAi = (v, tz) => ({
      visitId: v.objectID, // opaque reference for selectVisit
      account: v.accountName,
      subject: v.subject,
      date: formatLocalDate(tz, v.start),
      startTime: formatLocalTime(tz, v.start),
      endTime: formatLocalTime(tz, v.end)
    })

    this.on('findVisit', async (req) => {
      const session = await this.loadOwnSession(req, req.data.sessionId)
      if (session.status !== 'ACTIVE') return fail('VISIT_ALREADY_SELECTED', 'A Visit is already selected for this session.')

      let visits
      try {
        visits = await c4c.findOpenVisitsForUser(session.userEmail, localDayRangeUtc(session.timeZone))
      } catch {
        return fail('C4C_UNAVAILABLE', 'SAP Sales Cloud is not reachable. Tell the user to try again later.')
      }
      // Defence in depth: keep only Visits where the user really is Owner or Organizer.
      visits = visits.filter(v => c4c.isOwnerOrOrganizer(v, session.userEmail))

      await UPDATE(VoiceSessions, session.ID).with({ visitCandidates: JSON.stringify(visits.map(v => v.objectID)) })

      if (!visits.length) {
        await UPDATE(VoiceSessions, session.ID).with({ status: 'NO_VISIT' })
        await audit(req, 'VISIT_NOT_FOUND', { sessionId: session.ID, outcome: 'NO_VISIT' })
        return fail('NO_VISIT',
          'No open Visit today where the user is owner or organizer. Tell the user that the Visit must first be created in SAP Sales Cloud, then end the conversation. Do not offer to create it.')
      }
      const candidates = visits.map(v => visitForAi(v, session.timeZone))
      if (visits.length === 1) {
        return ok('VISIT_FOUND', 'Exactly one Visit found. Ask the user to confirm it (account and time) before calling selectVisit.', { candidates })
      }
      return ok('AMBIGUOUS', 'Several Visits found. Ask the user which one is meant (e.g. by account or time) – do not read out a long list and never guess. Then call selectVisit.', { candidates })
    })

    this.on('selectVisit', async (req) => {
      const session = await this.loadOwnSession(req, req.data.sessionId)
      if (session.status !== 'ACTIVE') return fail('VISIT_ALREADY_SELECTED', 'A Visit is already selected for this session.')
      const candidates = JSON.parse(session.visitCandidates || '[]')
      const { visitObjectID } = req.data
      if (!candidates.includes(visitObjectID)) {
        return fail('NOT_A_CANDIDATE', 'This visitId was not returned by findVisit. Use only a visitId from the findVisit result.')
      }

      // Re-read fresh from C4C and re-check all rules – the candidate list may be outdated.
      let visit
      try {
        visit = await c4c.getVisit(visitObjectID)
      } catch {
        return fail('C4C_UNAVAILABLE', 'SAP Sales Cloud is not reachable. Tell the user to try again later.')
      }
      if (!visit || visit.markedForDeletion) return fail('VISIT_GONE', 'The Visit no longer exists in SAP Sales Cloud.')
      if (!c4c.isOwnerOrOrganizer(visit, session.userEmail)) return fail('NOT_OWNER', 'The user is no longer owner or organizer of this Visit.')
      if (visit.status !== '1') return fail('VISIT_NOT_OPEN', 'The Visit is no longer open in SAP Sales Cloud.')

      await INSERT.into(VisitDrafts).entries({
        session_ID: session.ID,
        c4cVisitObjectID: visit.objectID,
        c4cVisitID: visit.id,
        c4cVisitETag: visit.etag,
        c4cSubject: visit.subject,
        c4cAccountUUID: visit.accountUUID,
        c4cAccountName: visit.accountName,
        c4cPlannedStart: visit.start?.toISOString(),
        c4cPlannedEnd: visit.end?.toISOString()
      })
      await UPDATE(VoiceSessions, session.ID).with({ status: 'VISIT_SELECTED' })
      await audit(req, 'VISIT_SELECTED', { sessionId: session.ID, visitObjectID: visit.objectID, outcome: 'OK' })
      return ok('VISIT_SELECTED', 'Visit selected. Ask the user what was discussed.', visitForAi(visit, session.timeZone))
    })

    /** Loads the session and its draft; requires a selected Visit. */
    const loadSessionWithVisit = async (req) => {
      const session = await this.loadOwnSession(req, req.data.sessionId)
      const draft = await SELECT.one.from(VisitDrafts).where({ session_ID: session.ID })
      if (!draft?.c4cVisitObjectID) return { session, draft: null }
      return { session, draft }
    }

    this.on('getVisitContext', async (req) => {
      const { session, draft } = await loadSessionWithVisit(req)
      if (!draft) return fail('NO_VISIT_SELECTED', 'Call findVisit and selectVisit first.')
      let visit
      try {
        visit = await c4c.getVisit(draft.c4cVisitObjectID)
      } catch {
        return fail('C4C_UNAVAILABLE', 'SAP Sales Cloud is not reachable.')
      }
      if (!visit) return fail('VISIT_GONE', 'The Visit no longer exists in SAP Sales Cloud.')
      return ok('VISIT_CONTEXT', 'Context of the selected Visit (read-only).', {
        ...visitForAi(visit, session.timeZone),
        primaryContact: visit.primaryContactName,
        location: visit.location
      })
    })

    this.on('resolveEmployee', async (req) => {
      const { draft } = await loadSessionWithVisit(req)
      if (!draft) return fail('NO_VISIT_SELECTED', 'Call findVisit and selectVisit first.')
      const name = String(req.data.name ?? '').trim()
      if (!name || name.length > 255) return fail('INVALID_NAME', 'Provide the colleague name as spoken, e.g. "Patrick" or "Patrick Müller".')
      let employees
      try {
        employees = await c4c.findActiveEmployeesByName(name)
      } catch {
        return fail('C4C_UNAVAILABLE', 'SAP Sales Cloud is not reachable.')
      }
      const matches = employees.map(e => ({ name: e.name }))
      if (!employees.length) return fail('EMPLOYEE_NOT_FOUND', 'No active employee with this name. Ask the user for the full name or another colleague.', { matches })
      if (employees.length > 1) return ok('AMBIGUOUS', 'Several active employees match. Ask the user which one is meant (e.g. by last name). Never guess.', { matches })
      return ok('EMPLOYEE_FOUND', 'Exactly one active employee matches.', { matches })
    })

    // --- draft helpers -----------------------------------------------------------------------

    /** Supersedes any PENDING CommitConfirmation and reverts PREVIEW status to VISIT_SELECTED. */
    const invalidatePreview = async (session) => {
      await UPDATE(CommitConfirmations).with({ status: 'SUPERSEDED' })
        .where({ session_ID: session.ID, status: 'PENDING' })
      if (session.status === 'PREVIEW') {
        await UPDATE(VoiceSessions, session.ID).with({ status: 'VISIT_SELECTED' })
      }
    }

    /** Resolves an employee by spoken name. Returns { status, uuid, bpid, displayName, message }. */
    const resolveProcessorByName = async (name) => {
      let employees
      try {
        employees = await c4c.findActiveEmployeesByName(name)
      } catch {
        return { status: 'C4C_ERROR' }
      }
      if (!employees.length) return { status: 'INVALID', message: `No active employee found for "${name}".` }
      if (employees.length > 1) return { status: 'AMBIGUOUS', message: `Multiple employees match "${name}". Use resolveEmployee and then updateTaskDraft.` }
      return { status: 'VALID', uuid: employees[0].uuid, bpid: employees[0].businessPartnerID, displayName: employees[0].name }
    }

    // --- draft – Visit (phase 3) -------------------------------------------------------------

    this.on('updateVisitDraft', async (req) => {
      const { sessionId, summary, actualEndTime, usePlannedEnd } = req.data
      const { session, draft } = await loadSessionWithVisit(req)
      if (!draft) return fail('NO_VISIT_SELECTED', 'Call findVisit and selectVisit first.')
      if (session.status === 'COMMITTING') return fail('COMMIT_RUNNING', 'Saving is in progress.')

      const trimmedSummary = String(summary ?? '').trim()
      if (!trimmedSummary) return fail('SUMMARY_MISSING', 'The summary must not be empty.')

      let proposedActualEnd = null
      let actualEndSource = null

      if (usePlannedEnd) {
        if (!draft.c4cPlannedEnd) return fail('NO_PLANNED_END', 'The Visit has no planned end time. Provide actualEndTime instead.')
        proposedActualEnd = draft.c4cPlannedEnd
        actualEndSource = 'PLANNED_FALLBACK'
      } else if (actualEndTime) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(actualEndTime).trim())
        if (!m) return fail('INVALID_END_TIME', 'actualEndTime must be HH:mm (e.g. "14:30").')
        const hh = Number(m[1])
        const mm = Number(m[2])
        if (hh > 23 || mm > 59) return fail('INVALID_END_TIME', 'actualEndTime must be a valid HH:mm time.')

        // Convert to UTC on the visit's local start day.
        const ref = new Date(draft.c4cPlannedStart)
        const { y, m: mo, d } = localDate(session.timeZone, ref)
        const utc = zonedTimeToUtc(session.timeZone, y, mo, d, hh, mm)

        if (utc > new Date()) return fail('END_TIME_IN_FUTURE', 'The actual end time is in the future. Ask the user for the correct time.')
        proposedActualEnd = utc.toISOString()
        actualEndSource = 'USER_STATED'
      } else {
        return fail('END_TIME_MISSING', 'Provide actualEndTime (HH:mm) or set usePlannedEnd to true.')
      }

      await invalidatePreview(session)
      await UPDATE(VisitDrafts, draft.ID).with({
        proposedSummary: trimmedSummary,
        proposedActualEnd,
        actualEndSource,
        version: (draft.version ?? 1) + 1
      })

      return ok('DRAFT_UPDATED', 'Draft updated. Call addTaskDraft for follow-up tasks or prepareCommitPreview when ready.')
    })

    // --- draft – Tasks (phase 4) -------------------------------------------------------------

    this.on('addTaskDraft', async (req) => {
      const { sessionId, subject, description, dueDate, processorName } = req.data
      const { session, draft } = await loadSessionWithVisit(req)
      if (!draft) return fail('NO_VISIT_SELECTED', 'Call findVisit and selectVisit first.')
      if (session.status === 'COMMITTING') return fail('COMMIT_RUNNING', 'Saving is in progress.')

      const trimmedSubject = String(subject ?? '').trim()
      if (!trimmedSubject) return fail('SUBJECT_MISSING', 'Task subject must not be empty.')
      if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(dueDate))) {
        return fail('INVALID_DUE_DATE', 'dueDate must be YYYY-MM-DD.')
      }

      const name = String(processorName ?? '').trim()
      let processorStatus, c4cProcessorUUID, c4cProcessorBPID, c4cProcessorName, processorMessage

      if (name) {
        const resolved = await resolveProcessorByName(name)
        if (resolved.status === 'C4C_ERROR') return fail('C4C_UNAVAILABLE', 'SAP Sales Cloud is not reachable.')
        processorStatus = resolved.status
        c4cProcessorUUID = resolved.uuid ?? null
        c4cProcessorBPID = resolved.bpid ?? null
        c4cProcessorName = resolved.displayName ?? null
        processorMessage = resolved.message ?? null
      } else {
        // No name → user is processor
        processorStatus = 'VALID'
        c4cProcessorUUID = session.c4cEmployeeUUID
        c4cProcessorBPID = session.c4cEmployeeBPID
        c4cProcessorName = null
        processorMessage = null
      }

      const existingTasks = await SELECT.from(TaskDrafts).where({ visitDraft_ID: draft.ID })
      const taskId = cds.utils.uuid()
      await INSERT.into(TaskDrafts).entries({
        ID: taskId,
        visitDraft_ID: draft.ID,
        position: existingTasks.length + 1,
        proposedSubject: trimmedSubject,
        proposedDescription: String(description ?? '').trim() || null,
        proposedDueDate: dueDate || null,
        proposedProcessorName: name || null,
        processorStatus,
        processorMessage,
        c4cProcessorUUID,
        c4cProcessorBPID,
        c4cProcessorName
      })

      await invalidatePreview(session)

      const data = { taskId, subject: trimmedSubject, processorStatus }
      if (processorStatus !== 'VALID') data.processorMessage = processorMessage
      return ok('TASK_ADDED',
        processorStatus === 'VALID'
          ? 'Task draft added.'
          : 'Task draft added but processor could not be resolved. Use resolveEmployee, then updateTaskDraft to fix.',
        data)
    })

    this.on('updateTaskDraft', async (req) => {
      const { sessionId, taskId, subject, description, dueDate, processorName } = req.data
      const { session, draft } = await loadSessionWithVisit(req)
      if (!draft) return fail('NO_VISIT_SELECTED', 'Call findVisit and selectVisit first.')
      if (session.status === 'COMMITTING') return fail('COMMIT_RUNNING', 'Saving is in progress.')
      if (!taskId) return fail('TASK_ID_MISSING', 'taskId is required.')

      const task = await SELECT.one.from(TaskDrafts).where({ ID: taskId, visitDraft_ID: draft.ID })
      if (!task) return fail('TASK_NOT_FOUND', 'Task not found in this session.')

      const newSubject = subject !== undefined ? String(subject).trim() : task.proposedSubject
      if (!newSubject) return fail('SUBJECT_MISSING', 'Task subject must not be empty.')
      if (dueDate !== undefined && dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(dueDate))) {
        return fail('INVALID_DUE_DATE', 'dueDate must be YYYY-MM-DD.')
      }

      let processorStatus = task.processorStatus
      let c4cProcessorUUID = task.c4cProcessorUUID
      let c4cProcessorBPID = task.c4cProcessorBPID
      let c4cProcessorName = task.c4cProcessorName
      let processorMessage = task.processorMessage

      if (processorName !== undefined) {
        const name = String(processorName ?? '').trim()
        if (name) {
          const resolved = await resolveProcessorByName(name)
          if (resolved.status === 'C4C_ERROR') return fail('C4C_UNAVAILABLE', 'SAP Sales Cloud is not reachable.')
          processorStatus = resolved.status
          c4cProcessorUUID = resolved.uuid ?? null
          c4cProcessorBPID = resolved.bpid ?? null
          c4cProcessorName = resolved.displayName ?? null
          processorMessage = resolved.message ?? null
        } else {
          // Empty processor → user is processor
          processorStatus = 'VALID'
          c4cProcessorUUID = session.c4cEmployeeUUID
          c4cProcessorBPID = session.c4cEmployeeBPID
          c4cProcessorName = null
          processorMessage = null
        }
      }

      await UPDATE(TaskDrafts, task.ID).with({
        proposedSubject: newSubject,
        proposedDescription: description !== undefined ? (String(description ?? '').trim() || null) : task.proposedDescription,
        proposedDueDate: dueDate !== undefined ? (dueDate || null) : task.proposedDueDate,
        proposedProcessorName: processorName !== undefined ? (String(processorName ?? '').trim() || null) : task.proposedProcessorName,
        processorStatus,
        processorMessage,
        c4cProcessorUUID,
        c4cProcessorBPID,
        c4cProcessorName
      })

      await invalidatePreview(session)

      const data = { processorStatus }
      if (processorStatus !== 'VALID') data.processorMessage = processorMessage
      return ok('TASK_UPDATED',
        processorStatus === 'VALID' ? 'Task draft updated.' : 'Task draft updated but processor still unresolved.',
        data)
    })

    this.on('removeTaskDraft', async (req) => {
      const { sessionId, taskId } = req.data
      const { session, draft } = await loadSessionWithVisit(req)
      if (!draft) return fail('NO_VISIT_SELECTED', 'Call findVisit and selectVisit first.')
      if (session.status === 'COMMITTING') return fail('COMMIT_RUNNING', 'Saving is in progress.')
      if (!taskId) return fail('TASK_ID_MISSING', 'taskId is required.')

      const task = await SELECT.one.from(TaskDrafts).where({ ID: taskId, visitDraft_ID: draft.ID })
      if (!task) return fail('TASK_NOT_FOUND', 'Task not found in this session.')

      await DELETE.from(TaskDrafts).where({ ID: taskId })
      await invalidatePreview(session)
      return ok('TASK_REMOVED', 'Task draft removed.')
    })

    // --- confirmation (phase 3) --------------------------------------------------------------

    this.on('prepareCommitPreview', async (req) => {
      const { sessionId } = req.data
      const { session, draft } = await loadSessionWithVisit(req)
      if (!draft) return fail('NO_VISIT_SELECTED', 'Call findVisit and selectVisit first.')
      if (session.status === 'COMMITTING') return fail('COMMIT_RUNNING', 'Saving is in progress.')
      if (!['VISIT_SELECTED', 'PREVIEW'].includes(session.status)) {
        return fail('WRONG_SESSION_STATE', `Cannot prepare a preview in state ${session.status}.`)
      }
      if (!draft.proposedSummary?.trim()) {
        return fail('SUMMARY_MISSING', 'Call updateVisitDraft first to provide a summary and end time.')
      }
      if (!draft.proposedActualEnd) {
        return fail('END_TIME_MISSING', 'Call updateVisitDraft first to provide an end time.')
      }

      const tasks = await SELECT.from(TaskDrafts).where({ visitDraft_ID: draft.ID }).orderBy('position asc')
      const unresolved = tasks.filter(t => t.processorStatus !== 'VALID')
      if (unresolved.length) {
        return fail('UNRESOLVED_PROCESSORS',
          `${unresolved.length} task(s) have an unresolved processor. Fix them with updateTaskDraft before creating the preview.`,
          { unresolvedTaskIds: unresolved.map(t => t.ID) })
      }

      // Build deterministic hash input (frozen snapshot of the draft).
      const hashInput = JSON.stringify({
        visitObjectID: draft.c4cVisitObjectID,
        visitETag: draft.c4cVisitETag,
        version: draft.version,
        summary: draft.proposedSummary,
        actualEnd: draft.proposedActualEnd,
        actualEndSource: draft.actualEndSource,
        tasks: tasks.map(t => ({
          id: t.ID,
          subject: t.proposedSubject,
          description: t.proposedDescription,
          dueDate: t.proposedDueDate,
          processorUUID: t.c4cProcessorUUID
        }))
      })
      const previewHash = createHash('sha256').update(hashInput).digest('hex')

      // Build human-readable preview text in the session language.
      const isDE = (session.language ?? 'de') === 'de'
      const endTimeStr = formatLocalTime(session.timeZone, new Date(draft.proposedActualEnd))
      const endDateStr = formatLocalDate(session.timeZone, new Date(draft.proposedActualEnd))
      const sourceNote = draft.actualEndSource === 'PLANNED_FALLBACK'
        ? (isDE ? ' (geplante Endzeit)' : ' (planned end time)')
        : ''
      const lines = []
      if (isDE) {
        lines.push(`Besuch bei ${draft.c4cAccountName}: ${draft.c4cSubject}`)
        lines.push(`Endzeit: ${endTimeStr} am ${endDateStr}${sourceNote}`)
        lines.push(`Zusammenfassung: ${draft.proposedSummary}`)
        if (tasks.length) {
          lines.push(`${tasks.length} Folge-Aufgabe(n):`)
          for (const t of tasks) {
            const proc = t.c4cProcessorName ?? 'Sie'
            const due = t.proposedDueDate ? `, fällig ${t.proposedDueDate}` : ''
            lines.push(`  – ${t.proposedSubject}${due}, Bearbeiter: ${proc}`)
          }
        } else {
          lines.push('Keine Folge-Aufgaben.')
        }
        lines.push('Soll ich das so speichern?')
      } else {
        lines.push(`Visit at ${draft.c4cAccountName}: ${draft.c4cSubject}`)
        lines.push(`End time: ${endTimeStr} on ${endDateStr}${sourceNote}`)
        lines.push(`Summary: ${draft.proposedSummary}`)
        if (tasks.length) {
          lines.push(`${tasks.length} follow-up task(s):`)
          for (const t of tasks) {
            const proc = t.c4cProcessorName ?? 'You'
            const due = t.proposedDueDate ? `, due ${t.proposedDueDate}` : ''
            lines.push(`  – ${t.proposedSubject}${due}, assigned to: ${proc}`)
          }
        } else {
          lines.push('No follow-up tasks.')
        }
        lines.push('Shall I save this?')
      }
      const previewText = lines.join('\n')

      // Supersede previous confirmations (draft may have been edited since last preview).
      await UPDATE(CommitConfirmations).with({ status: 'SUPERSEDED' })
        .where({ session_ID: session.ID, status: 'PENDING' })

      await INSERT.into(CommitConfirmations).entries({
        ID: cds.utils.uuid(),
        session_ID: session.ID,
        draftVersion: draft.version,
        previewHash,
        previewText,
        status: 'PENDING'
      })
      await UPDATE(VoiceSessions, session.ID).with({ status: 'PREVIEW' })

      return ok('PREVIEW_READY',
        'Preview prepared. Read the previewText to the user verbatim and wait for a clear confirmation.',
        { previewHash, previewText })
    })

    this.on('confirmCommit', async (req) => {
      const { sessionId, previewHash, userUtterance } = req.data
      const session = await this.loadOwnSession(req, sessionId)
      if (!session) return
      if (session.status !== 'PREVIEW') return fail('NOT_IN_PREVIEW', 'Call prepareCommitPreview first, then ask the user to confirm.')

      const confirmation = await SELECT.one.from(CommitConfirmations)
        .where({ session_ID: session.ID, status: 'PENDING' })
        .orderBy('createdAt desc')
      if (!confirmation) return fail('NO_PENDING_PREVIEW', 'No pending preview found. Call prepareCommitPreview again.')
      if (confirmation.previewHash !== previewHash) {
        return fail('HASH_MISMATCH', 'The preview hash does not match the pending preview. Call prepareCommitPreview again to get the current hash.')
      }

      const utterance = String(userUtterance ?? '').toLowerCase().trim()
      if (!utterance) return fail('NO_UTTERANCE', 'userUtterance must contain the transcribed user confirmation.')
      const hasYes = matchesWord(utterance, YES_WORDS)
      const hasNo = matchesWord(utterance, NO_WORDS)
      if (hasNo && !hasYes) {
        return fail('DENIED', 'The user did not confirm. Ask if they want to change something, then call prepareCommitPreview again.')
      }
      if (!hasYes) {
        return fail('UNCLEAR', 'The utterance does not clearly confirm. Read the preview again and ask for a clear yes or no.')
      }

      // Confirmed – mark session as COMMITTING and start C4C writes.
      await UPDATE(CommitConfirmations, confirmation.ID).with({
        status: 'CONFIRMED',
        confirmedAt: new Date().toISOString(),
        confirmationUtterance: userUtterance?.slice(0, 500)
      })
      await UPDATE(VoiceSessions, session.ID).with({ status: 'COMMITTING' })
      await audit(req, 'COMMIT_STARTED', { sessionId: session.ID, outcome: 'CONFIRMED' })

      const draft = await SELECT.one.from(VisitDrafts).where({ session_ID: session.ID })
      const tasks = await SELECT.from(TaskDrafts).where({ visitDraft_ID: draft.ID }).orderBy('position asc')

      // Build CommitOperations (idempotency keys prevent double-execution on retry).
      const ops = []
      for (const t of tasks) {
        ops.push({ kind: 'CREATE_TASK', taskDraft_ID: t.ID, key: `${session.ID}:CREATE_TASK:${t.ID}` })
        if (t.proposedDescription) ops.push({ kind: 'CREATE_TASK_TEXT', taskDraft_ID: t.ID, key: `${session.ID}:CREATE_TASK_TEXT:${t.ID}` })
        ops.push({ kind: 'CREATE_TASK_LINK', taskDraft_ID: t.ID, key: `${session.ID}:CREATE_TASK_LINK:${t.ID}` })
      }
      ops.push({ kind: 'UPDATE_VISIT_END', key: `${session.ID}:UPDATE_VISIT_END:${draft.c4cVisitObjectID}` })
      ops.push({ kind: 'UPDATE_VISIT_STATUS', key: `${session.ID}:UPDATE_VISIT_STATUS:${draft.c4cVisitObjectID}` })

      for (let i = 0; i < ops.length; i++) {
        await INSERT.into(CommitOperations).entries({
          ID: cds.utils.uuid(),
          session_ID: session.ID,
          confirmation_ID: confirmation.ID,
          taskDraft_ID: ops[i].taskDraft_ID ?? null,
          seq: i + 1,
          kind: ops[i].kind,
          idempotencyKey: ops[i].key,
          status: 'PENDING'
        })
      }

      // Execute operations sequentially (order matters: tasks before visit close).
      const failed = []
      const taskC4cIds = {} // taskDraftId → { objectID, visitID }

      for (const op of ops) {
        const dbOp = await SELECT.one.from(CommitOperations).where({ idempotencyKey: op.key, session_ID: session.ID })
        await UPDATE(CommitOperations, dbOp.ID).with({ status: 'IN_PROGRESS', attempts: (dbOp.attempts ?? 0) + 1 })
        try {
          if (op.kind === 'CREATE_TASK') {
            const t = tasks.find(x => x.ID === op.taskDraft_ID)
            const dueUtc = t.proposedDueDate ? new Date(t.proposedDueDate + 'T00:00:00Z') : null
            const taskObjId = await c4c.createTask({
              subject: t.proposedSubject,
              dueDateTimeUtc: dueUtc,
              accountUUID: draft.c4cAccountUUID,
              ownerUUID: session.c4cEmployeeUUID,
              processorUUID: t.c4cProcessorUUID,
              processorPartyID: t.c4cProcessorBPID
            })
            taskC4cIds[t.ID] = { objectID: taskObjId }
            await UPDATE(CommitOperations, dbOp.ID).with({ status: 'SUCCEEDED', c4cObjectID: taskObjId })
          } else if (op.kind === 'CREATE_TASK_TEXT') {
            const t = tasks.find(x => x.ID === op.taskDraft_ID)
            const taskObjId = taskC4cIds[t.ID]?.objectID
            if (!taskObjId) throw new Error('CREATE_TASK must have succeeded first')
            await c4c.createTaskText(taskObjId, t.proposedDescription)
            await UPDATE(CommitOperations, dbOp.ID).with({ status: 'SUCCEEDED' })
          } else if (op.kind === 'CREATE_TASK_LINK') {
            const t = tasks.find(x => x.ID === op.taskDraft_ID)
            const taskObjId = taskC4cIds[t.ID]?.objectID
            if (!taskObjId) throw new Error('CREATE_TASK must have succeeded first')
            await c4c.createTaskBtdReference(taskObjId, draft.c4cVisitID)
            await UPDATE(CommitOperations, dbOp.ID).with({ status: 'SUCCEEDED' })
          } else if (op.kind === 'UPDATE_VISIT_END') {
            // Re-read fresh ETag before PATCH.
            const freshVisit = await c4c.getVisit(draft.c4cVisitObjectID)
            if (!freshVisit) throw new Error('Visit no longer exists in C4C')
            await c4c.patchVisit(draft.c4cVisitObjectID, freshVisit.etag, { actualEndDateTime: draft.proposedActualEnd })
            await UPDATE(CommitOperations, dbOp.ID).with({ status: 'SUCCEEDED' })
          } else if (op.kind === 'UPDATE_VISIT_STATUS') {
            const freshVisit = await c4c.getVisit(draft.c4cVisitObjectID)
            if (!freshVisit) throw new Error('Visit no longer exists in C4C')
            await c4c.patchVisit(draft.c4cVisitObjectID, freshVisit.etag, { status: VISIT_STATUS.COMPLETED })
            await UPDATE(CommitOperations, dbOp.ID).with({ status: 'SUCCEEDED' })
          }
        } catch (err) {
          const errMsg = err?.message?.slice(0, 1000) ?? 'unknown error'
          await UPDATE(CommitOperations, dbOp.ID).with({ status: 'FAILED', lastError: errMsg })
          failed.push({ kind: op.kind, error: errMsg })
          // If a critical visit operation fails, abort remaining visit ops.
          if (op.kind === 'UPDATE_VISIT_END' || op.kind === 'UPDATE_VISIT_STATUS') break
        }
      }

      const visitClosed = !failed.some(f => f.kind === 'UPDATE_VISIT_STATUS')
      const anySucceeded = Object.keys(taskC4cIds).length > 0 || failed.length < ops.length

      let finalStatus
      if (!failed.length) {
        finalStatus = 'COMPLETED'
      } else if (!visitClosed && !anySucceeded) {
        finalStatus = 'FAILED'
      } else {
        finalStatus = 'PARTIAL_FAILURE'
      }

      await UPDATE(VoiceSessions, session.ID).with({ status: finalStatus })
      await audit(req, 'COMMIT_FINISHED', {
        sessionId: session.ID,
        visitObjectID: draft.c4cVisitObjectID,
        outcome: finalStatus,
        details: failed.length ? JSON.stringify(failed.map(f => f.kind)) : undefined
      })

      if (finalStatus === 'COMPLETED') {
        return ok('COMMITTED', 'All changes were saved successfully in SAP Sales Cloud. The visit is now completed. The session is closed.')
      }
      const failedKinds = failed.map(f => f.kind).join(', ')
      return fail(finalStatus,
        `Some operations failed: ${failedKinds}. Tell the user what succeeded and what did not. The session is closed.`,
        { failed: failed.map(f => ({ kind: f.kind, error: f.error })) })
    })

    return super.init()
  }
}
