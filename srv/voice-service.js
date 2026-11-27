import { createHash } from 'node:crypto'
import cds from '@sap/cds'
import { ok, fail } from './lib/tool-result.js'
import { isValidTimeZone, normaliseLanguage } from './lib/validation.js'
import * as c4c from './lib/c4c-client.js'
import { VISIT_ATTACHMENT, VISIT_STATUS } from './lib/c4c-codes.js'
import { localDayRangeUtc, formatLocalTime, formatGermanDate, germanIsoDate, spokenTime, zonedTimeToUtc, localDate } from './lib/time.js'
import { generateSummaryPdf, generateTranscriptPdf } from './lib/pdf-generator.js'

const LOG = cds.log('voice')
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql

// Session states in which the conversation is finished; no tool may change anything anymore.
const FINAL_STATES = ['COMPLETED', 'PARTIAL_FAILURE', 'FAILED', 'CANCELLED', 'NO_VISIT']

// YES / NO keywords for utterance check in confirmCommit.
const YES_WORDS = ['ja', 'jawohl', 'stimmt', 'korrekt', 'bitte', 'speichern', 'genau', 'ja bitte',
  'yes', 'correct', 'right', 'please', 'save', 'confirm', 'go ahead', 'sure', 'ok', 'okay']
// Any of these rejects the confirmation, even if a yes-word is present too
// ("Nein, bitte nicht speichern"). "don t" is "don't" after punctuation removal.
const NO_WORDS = ['nein', 'nee', 'nö', 'nicht', 'kein', 'keine', 'stop', 'stopp', 'warte', 'abbruch',
  'abbrechen', 'korrigieren', 'ändern', 'falsch',
  'no', 'not', 'don t', 'dont', 'wait', 'cancel', 'wrong', 'undo', 'change', 'halt']

const isDueTime = (v) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v))

function matchesWord (utterance, words) {
  const clean = utterance.replace(/[.,!?;:'"()-]/g, ' ').replace(/\s+/g, ' ').trim()
  return words.some(w => clean === w || clean.startsWith(w + ' ') || clean.endsWith(' ' + w) || clean.includes(' ' + w + ' '))
}

export default class VoiceAssistantService extends cds.ApplicationService {
  init () {
    const { VoiceSessions, VisitDrafts, TaskDrafts, CommitConfirmations, CommitOperations, TranscriptEntries, AuditLog } = cds.entities('voice')
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
        // In development (mocked auth) with no destination binding: synthesise an employee
        // so the conversation flow can be tested end-to-end without a real C4C connection.
        if (cds.env.requires?.auth?.kind === 'mocked') {
          LOG.warn('startSession: C4C unreachable in dev mode – using synthetic employee', { userEmail })
          employees = [{ uuid: cds.utils.uuid(), businessPartnerID: '0000000000', name: req.user.id, email: userEmail }]
        } else {
          return fail('C4C_UNAVAILABLE', 'SAP Sales Cloud is not reachable. Tell the user to try again later.')
        }
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
      customer: v.accountName,
      subject: v.subject,
      date: formatGermanDate(tz, v.start),
      startTime: formatLocalTime(tz, v.start),
      endTime: formatLocalTime(tz, v.end),
      startTimeSpoken: spokenTime(formatLocalTime(tz, v.start)),
      endTimeSpoken: spokenTime(formatLocalTime(tz, v.end))
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
        return ok('VISIT_FOUND', 'Exactly one Visit found. Ask the user to confirm it (customer name and time; in German say "Kunde", never "Account") before calling selectVisit.', { candidates })
      }
      return ok('AMBIGUOUS', 'Several Visits found. Ask the user which one is meant (e.g. by customer or time; in German say "Kunde", never "Account") – do not read out a long list and never guess. Then call selectVisit.', { candidates })
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

    // --- task helpers (phase 4) ------------------------------------------------------------------

    /** Resolves a processor from C4C by name, or falls back to the current user. */
    const resolveProcessor = async (processorName, session) => {
      const name = String(processorName ?? '').trim()
      if (!name) {
        let userEmployees
        try { userEmployees = await c4c.findActiveEmployeesByEmail(session.userEmail) } catch { /* fall back to UUID-only */ }
        return {
          processorStatus: 'VALID',
          c4cProcessorUUID: session.c4cEmployeeUUID,
          c4cProcessorBPID: session.c4cEmployeeBPID,
          c4cProcessorName: userEmployees?.[0]?.name ?? null,
          proposedProcessorName: null,
          processorMessage: null,
          matches: []
        }
      }
      let employees
      try { employees = await c4c.findActiveEmployeesByName(name) } catch {
        return { processorStatus: 'INVALID', c4cProcessorUUID: null, c4cProcessorBPID: null, c4cProcessorName: null, proposedProcessorName: name, processorMessage: 'SAP Sales Cloud is not reachable.', matches: [] }
      }
      if (!employees.length) return { processorStatus: 'INVALID', c4cProcessorUUID: null, c4cProcessorBPID: null, c4cProcessorName: null, proposedProcessorName: name, processorMessage: `No active employee with name "${name}".`, matches: [] }
      if (employees.length > 1) return { processorStatus: 'AMBIGUOUS', c4cProcessorUUID: null, c4cProcessorBPID: null, c4cProcessorName: null, proposedProcessorName: name, processorMessage: `Multiple employees match "${name}". Provide the full name.`, matches: employees.map(e => ({ name: e.name })) }
      const e = employees[0]
      return { processorStatus: 'VALID', c4cProcessorUUID: e.uuid, c4cProcessorBPID: e.businessPartnerID, c4cProcessorName: e.name, proposedProcessorName: name, processorMessage: null, matches: [] }
    }

    /** Increments the visit draft version; if in PREVIEW, reverts session and supersedes the pending confirmation. */
    const bumpDraft = async (session, draft) => {
      if (session.status === 'PREVIEW') {
        await UPDATE(CommitConfirmations).with({ status: 'SUPERSEDED' }).where({ session_ID: session.ID, status: 'PENDING' })
        await UPDATE(VoiceSessions, session.ID).with({ status: 'VISIT_SELECTED' })
      }
      await UPDATE(VisitDrafts, draft.ID).with({ version: (draft.version ?? 1) + 1 })
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

    // --- draft (phase 3) -------------------------------------------------------------------------

    this.on('updateVisitDraft', async (req) => {
      const { sessionId, summary, actualEndTime, usePlannedEnd } = req.data
      const { session, draft } = await loadSessionWithVisit(req)
      if (!session) return
      if (!draft) return fail('NO_VISIT_SELECTED', 'Call findVisit and selectVisit first.')
      if (!['VISIT_SELECTED', 'PREVIEW'].includes(session.status)) {
        return fail('SESSION_STATE_INVALID', 'The draft cannot be updated in the current session state.')
      }
      if (actualEndTime && usePlannedEnd) {
        return fail('CONFLICTING_END_PARAMS', 'Provide either actualEndTime or usePlannedEnd, not both.')
      }

      const updates = {}
      if (summary !== undefined && summary !== null) {
        const s = String(summary).trim()
        if (!s) return fail('SUMMARY_MISSING', 'The summary must not be empty.')
        updates.proposedSummary = s
      }

      if (usePlannedEnd) {
        if (!draft.c4cPlannedEnd) return fail('NO_PLANNED_END', 'The Visit has no planned end time.')
        updates.proposedActualEnd = draft.c4cPlannedEnd
        updates.actualEndSource = 'PLANNED_FALLBACK'
      } else if (actualEndTime != null) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(actualEndTime).trim())
        if (!m) return fail('INVALID_TIME_FORMAT', 'actualEndTime must be in HH:mm format, e.g. "14:30".')
        const hh = Number(m[1])
        const mm = Number(m[2])
        if (hh > 23 || mm > 59) return fail('INVALID_TIME_FORMAT', 'actualEndTime is not a valid time.')
        const visitStart = new Date(draft.c4cPlannedStart)
        if (isNaN(visitStart)) return fail('NO_PLANNED_START', 'The Visit has no planned start time.')
        const { y, m: month, d } = localDate(session.timeZone, visitStart)
        const actualEndUtc = zonedTimeToUtc(session.timeZone, y, month, d, hh, mm)
        if (actualEndUtc > new Date()) {
          return fail('ACTUAL_END_IN_FUTURE', 'The stated end time is in the future. Ask the user again or use the planned end time.')
        }
        updates.proposedActualEnd = actualEndUtc.toISOString()
        updates.actualEndSource = 'USER_STATED'
      }

      updates.version = (draft.version ?? 1) + 1

      if (session.status === 'PREVIEW') {
        await UPDATE(CommitConfirmations).with({ status: 'SUPERSEDED' })
          .where({ session_ID: sessionId, status: 'PENDING' })
        await UPDATE(VoiceSessions, session.ID).with({ status: 'VISIT_SELECTED' })
      }

      await UPDATE(VisitDrafts, draft.ID).with(updates)
      return ok('VISIT_DRAFT_UPDATED', 'Draft updated. Call prepareCommitPreview when ready to save.')
    })

    this.on('prepareCommitPreview', async (req) => {
      const { session, draft } = await loadSessionWithVisit(req)
      if (!session) return
      if (!draft) return fail('NO_VISIT_SELECTED', 'Call findVisit and selectVisit first.')
      if (!['VISIT_SELECTED', 'PREVIEW'].includes(session.status)) {
        return fail('SESSION_STATE_INVALID', 'Cannot prepare preview in the current session state.')
      }
      if (!draft.proposedSummary?.trim()) {
        return fail('SUMMARY_MISSING', 'The visit summary is missing. Ask the user what was discussed, then call updateVisitDraft first.')
      }
      const effectiveEnd = draft.proposedActualEnd ?? draft.c4cPlannedEnd
      if (!effectiveEnd) {
        return fail('END_TIME_MISSING', 'The end time is missing. Ask the user for the actual end time, or call updateVisitDraft with usePlannedEnd:true.')
      }

      const tasks = await SELECT.from(TaskDrafts).where({ visitDraft_ID: draft.ID }).orderBy('position')

      const unresolved = tasks.filter(t => t.processorStatus !== 'VALID')
      if (unresolved.length) {
        return fail('TASK_PROCESSOR_UNRESOLVED',
          `${unresolved.length} task(s) have an unresolved processor. Call updateTaskDraft for each task to provide a valid processor name.`)
      }

      // Hash over the frozen draft content – any change to the draft produces a different hash.
      const frozen = JSON.stringify({
        sessionId: session.ID,
        draftVersion: draft.version ?? 1,
        visitObjectID: draft.c4cVisitObjectID,
        proposedSummary: draft.proposedSummary ?? '',
        proposedActualEnd: effectiveEnd ?? '',
        actualEndSource: draft.actualEndSource ?? '',
        tasks: tasks.map(t => ({
          id: t.ID,
          subject: t.proposedSubject ?? '',
          description: t.proposedDescription ?? '',
          dueDate: t.proposedDueDate ?? '',
          dueTime: t.proposedDueTime ?? '',
          processorUUID: t.c4cProcessorUUID ?? ''
        }))
      })
      const previewHash = createHash('sha256').update(frozen).digest('hex')

      const isDE = session.language === 'de'
      const startTimeStr = formatLocalTime(session.timeZone, new Date(draft.c4cPlannedStart))
      const endTimeStr = formatLocalTime(session.timeZone, new Date(effectiveEnd))
      const visitDateStr = formatGermanDate(session.timeZone, new Date(draft.c4cPlannedStart))

      const taskLines = tasks.map((t, i) => isDE
        ? `  Aufgabe ${i + 1}: ${t.proposedSubject}${t.c4cProcessorName ? ` (Zuständig: ${t.c4cProcessorName})` : ''}${t.proposedDueDate ? `, fällig am ${germanIsoDate(t.proposedDueDate)}${t.proposedDueTime ? ` um ${t.proposedDueTime} Uhr` : ''}` : ''}`
        : `  Task ${i + 1}: ${t.proposedSubject}${t.c4cProcessorName ? ` (Assigned to: ${t.c4cProcessorName})` : ''}${t.proposedDueDate ? `, due ${germanIsoDate(t.proposedDueDate)}${t.proposedDueTime ? ` at ${t.proposedDueTime}` : ''}` : ''}`)

      let previewText
      if (isDE) {
        previewText = `Ich speichere jetzt folgendes in SAP Sales Cloud:\n\nBesuch bei ${draft.c4cAccountName} am ${visitDateStr} von ${startTimeStr} bis ${endTimeStr}.\n\nZusammenfassung: ${draft.proposedSummary}`
        if (taskLines.length) previewText += '\n\nFolge-Aufgaben:\n' + taskLines.join('\n')
        previewText += '\n\nBitte bestätigen Sie.'
      } else {
        previewText = `I will now save the following to SAP Sales Cloud:\n\nVisit at ${draft.c4cAccountName} on ${visitDateStr} from ${startTimeStr} to ${endTimeStr}.\n\nSummary: ${draft.proposedSummary}`
        if (taskLines.length) previewText += '\n\nFollow-up tasks:\n' + taskLines.join('\n')
        previewText += '\n\nPlease confirm.'
      }

      await UPDATE(CommitConfirmations).with({ status: 'SUPERSEDED' })
        .where({ session_ID: session.ID, status: 'PENDING' })

      await INSERT.into(CommitConfirmations).entries({
        ID: cds.utils.uuid(),
        session_ID: session.ID,
        draftVersion: draft.version ?? 1,
        previewHash,
        previewText,
        status: 'PENDING'
      })

      await UPDATE(VoiceSessions, session.ID).with({ status: 'PREVIEW' })

      return ok('COMMIT_PREVIEW', 'The preview is shown on the user\'s screen, do not read it out. Name only the key facts (customer, end time, tasks) in one or two short sentences. Then ask whether you should read the summary again (a yes to that is NOT a save confirmation). After that, ask separately for explicit yes/no confirmation to save. Pass the hash to confirmCommit together with the user\'s utterance.', {
        previewHash,
        previewText,
        endTimeSpoken: spokenTime(endTimeStr)
      })
    })

    // --- commit execution (phase 5) -------------------------------------------------------------

    /**
     * Executes all C4C write operations in sequence using idempotency keys.
     * Returns { finalStatus, visitObjectID, errors }.
     * Does NOT update VoiceSessions.status – the caller (confirmCommit) does that.
     */
    // What the user should hear/read when a single commit step fails
    const OP_LABELS = {
      ATTACH_SUMMARY_PDF: 'Zusammenfassung als PDF',
      ATTACH_TRANSCRIPT_PDF: 'Transkript als PDF',
      CREATE_TASK: 'Folgeaufgabe anlegen',
      CREATE_TASK_TEXT: 'Beschreibung der Aufgabe (die Aufgabe selbst wurde angelegt)',
      CREATE_TASK_LINK: 'Verknüpfung der Aufgabe mit dem Besuch (die Aufgabe selbst wurde angelegt)',
      UPDATE_VISIT_END: 'Tatsächliche Endzeit des Besuchs',
      UPDATE_VISIT_STATUS: 'Besuch auf "Abgeschlossen" setzen'
    }

    const runCommit = async (session, draft, confirmation, tasks, entries) => {
      const errors = []
      let seq = 0

      const runOp = async (kind, idempotencyKey, taskDraftId, fn) => {
        // Idempotency guard: skip if this op already succeeded (safe to retry)
        const existing = await SELECT.one.from(CommitOperations).where({ idempotencyKey })
        if (existing?.status === 'SUCCEEDED' || existing?.status === 'SKIPPED_EXISTING') {
          return { ok: true, c4cObjectID: existing.c4cObjectID, c4cID: existing.c4cID }
        }

        seq++
        let opId
        if (existing) {
          opId = existing.ID
          await UPDATE(CommitOperations, opId).with({ status: 'IN_PROGRESS', attempts: (existing.attempts ?? 0) + 1, seq })
        } else {
          opId = cds.utils.uuid()
          await INSERT.into(CommitOperations).entries({
            ID: opId,
            session_ID: session.ID,
            confirmation_ID: confirmation.ID,
            taskDraft_ID: taskDraftId ?? null,
            seq,
            kind,
            idempotencyKey,
            status: 'IN_PROGRESS',
            attempts: 1
          })
        }

        try {
          const result = await fn()
          await UPDATE(CommitOperations, opId).with({
            status: 'SUCCEEDED',
            c4cObjectID: result?.c4cObjectID ?? null,
            c4cID: result?.c4cID ?? null,
            lastError: null
          })
          return { ok: true, c4cObjectID: result?.c4cObjectID, c4cID: result?.c4cID }
        } catch (err) {
          const lastError = String(err?.message ?? err).slice(0, 1000)
          LOG.error(`commit op ${kind} failed`, { lastError })
          await UPDATE(CommitOperations, opId).with({ status: 'FAILED', lastError })
          const subject = tasks.find(t => t.ID === taskDraftId)?.proposedSubject
          const what = (OP_LABELS[kind] ?? kind) + (subject ? ` (Aufgabe "${subject}")` : '')
          errors.push({ kind, what, idempotencyKey, lastError })
          return { ok: false }
        }
      }

      await runOp('ATTACH_SUMMARY_PDF', `ATTACH_SUMMARY_PDF:${confirmation.ID}`, null, async () => {
        const pdfBytes = await generateSummaryPdf(draft, tasks, session.timeZone)
        await c4c.createVisitAttachment({
          visitObjectID: draft.c4cVisitObjectID,
          typeCode: VISIT_ATTACHMENT.TYPE_SUMMARY,
          name: 'Besuchszusammenfassung.pdf',
          pdfBytes
        })
      })

      await runOp('ATTACH_TRANSCRIPT_PDF', `ATTACH_TRANSCRIPT_PDF:${confirmation.ID}`, null, async () => {
        const pdfBytes = await generateTranscriptPdf(draft, entries, session.timeZone)
        await c4c.createVisitAttachment({
          visitObjectID: draft.c4cVisitObjectID,
          typeCode: VISIT_ATTACHMENT.TYPE_STANDARD,
          name: 'Transkript KI-Besuchsdokumentation.pdf',
          pdfBytes
        })
      })

      for (const task of tasks) {
        const taskResult = await runOp('CREATE_TASK', `CREATE_TASK:${task.ID}`, task.ID, async () => {
          const result = await c4c.createTask({
            subject: task.proposedSubject,
            dueDateISO: task.proposedDueDate ?? null,
            dueTime: task.proposedDueTime ?? null,
            timeZone: session.timeZone,
            accountUUID: draft.c4cAccountUUID,
            ownerUUID: session.c4cEmployeeUUID,
            processorUUID: task.c4cProcessorUUID,
            processorPartyID: task.c4cProcessorBPID ?? null
          })
          return { c4cObjectID: result.objectID, c4cID: result.id }
        })

        if (taskResult.ok && taskResult.c4cObjectID) {
          if (task.proposedDescription?.trim()) {
            await runOp('CREATE_TASK_TEXT', `CREATE_TASK_TEXT:${task.ID}`, task.ID,
              () => c4c.createTaskDescription(taskResult.c4cObjectID, task.proposedDescription)
            )
          }
          await runOp('CREATE_TASK_LINK', `CREATE_TASK_LINK:${task.ID}`, task.ID,
            () => c4c.createTaskVisitLink(taskResult.c4cObjectID, draft.c4cVisitID)
          )
        }
      }

      await runOp('UPDATE_VISIT_END', `UPDATE_VISIT_END:${confirmation.ID}`, null,
        () => c4c.patchVisit(draft.c4cVisitObjectID, draft.c4cVisitETag, {
          actualEnd: draft.proposedActualEnd ?? draft.c4cPlannedEnd
        })
      )

      await runOp('UPDATE_VISIT_STATUS', `UPDATE_VISIT_STATUS:${confirmation.ID}`, null,
        () => c4c.patchVisit(draft.c4cVisitObjectID, null, { status: VISIT_STATUS.COMPLETED })
      )

      return { finalStatus: errors.length === 0 ? 'COMPLETED' : 'PARTIAL_FAILURE', visitObjectID: draft.c4cVisitObjectID, errors }
    }

    this.on('confirmCommit', async (req) => {
      const { sessionId, previewHash, userUtterance } = req.data
      const session = await this.loadOwnSession(req, sessionId)
      if (!session) return
      if (session.status !== 'PREVIEW') return fail('NOT_IN_PREVIEW', 'Call prepareCommitPreview first, then ask the user to confirm.')

      const confirmation = await SELECT.one.from(CommitConfirmations)
        .where({ session_ID: sessionId, previewHash, status: 'PENDING' })
      if (!confirmation) {
        return fail('HASH_MISMATCH', 'The preview hash does not match the current preview. The draft may have changed. Call prepareCommitPreview again to get a fresh hash.')
      }

      const utterance = String(userUtterance ?? '').toLowerCase().trim()
      if (!utterance) return fail('NO_UTTERANCE', 'userUtterance must contain the transcribed user confirmation.')
      const hasYes = matchesWord(utterance, YES_WORDS)
      const hasNo = matchesWord(utterance, NO_WORDS)
      if (hasNo) {
        return fail('DENIED', 'The user did not confirm. Ask if they want to change something, then call prepareCommitPreview again.')
      }
      if (!hasYes) {
        return fail('UNCLEAR', 'The utterance does not clearly confirm. Briefly ask again for a clear yes or no.')
      }

      await UPDATE(CommitConfirmations, confirmation.ID).with({
        status: 'CONFIRMED',
        confirmedAt: new Date().toISOString(),
        confirmationUtterance: String(userUtterance ?? '').slice(0, 500)
      })
      await UPDATE(VoiceSessions, session.ID).with({ status: 'COMMITTING' })
      await audit(req, 'COMMIT_STARTED', { sessionId: session.ID, outcome: 'CONFIRMED' })

      const draft = await SELECT.one.from(VisitDrafts).where({ session_ID: session.ID })
      const tasks = await SELECT.from(TaskDrafts).where({ visitDraft_ID: draft.ID }).orderBy('position')
      const entries = await SELECT.from(TranscriptEntries).where({ session_ID: session.ID }).orderBy('seq')

      const { finalStatus, visitObjectID, errors } = await runCommit(session, draft, confirmation, tasks, entries)

      await UPDATE(VoiceSessions, session.ID).with({ status: finalStatus })
      await audit(req, `COMMIT_${finalStatus}`, { sessionId: session.ID, visitObjectID, outcome: finalStatus })

      if (finalStatus === 'COMPLETED') {
        return ok('COMMIT_COMPLETED', 'All data has been saved to SAP Sales Cloud successfully.')
      }
      return ok('COMMIT_PARTIAL_FAILURE',
        'Some operations failed. Name ONLY the steps listed in errors[].what and the reason in errors[].lastError (the SAP Sales Cloud message); ' +
        'everything not listed was saved. Never say a task was not created unless errors contains kind CREATE_TASK. ' +
        'e.g. a Visit with incomplete mandatory tasks or surveys cannot be set to Completed until they are done in SAP Sales Cloud.',
        { errors })
    })

    // --- task drafts (phase 4) -------------------------------------------------------------------

    this.on('addTaskDraft', async (req) => {
      const { subject, description, dueDate, dueTime, processorName } = req.data
      const { session, draft } = await loadSessionWithVisit(req)
      if (!session) return
      if (!draft) return fail('NO_VISIT_SELECTED', 'Call findVisit and selectVisit first.')
      if (!['VISIT_SELECTED', 'PREVIEW'].includes(session.status)) {
        return fail('SESSION_STATE_INVALID', 'Tasks cannot be added in the current session state.')
      }
      const subjectStr = String(subject ?? '').trim()
      if (!subjectStr) return fail('SUBJECT_REQUIRED', 'A task subject is required.')
      if (subjectStr.length > 765) return fail('SUBJECT_TOO_LONG', 'Task subject must be at most 765 characters.')
      if (dueTime && !isDueTime(dueTime)) return fail('INVALID_TIME_FORMAT', 'dueTime must be in HH:mm format, e.g. "14:30".')
      if (dueTime && !dueDate) return fail('DUE_DATE_REQUIRED', 'A due time needs a due date. Ask the user for the date.')

      const processor = await resolveProcessor(processorName, session)
      const existing = await SELECT.from(TaskDrafts).where({ visitDraft_ID: draft.ID })
      const position = existing.reduce((max, t) => Math.max(max, t.position ?? 0), 0) + 1

      const taskID = cds.utils.uuid()
      await INSERT.into(TaskDrafts).entries({
        ID: taskID,
        visitDraft_ID: draft.ID,
        position,
        proposedSubject: subjectStr,
        proposedDescription: description ?? null,
        proposedDueDate: dueDate ?? null,
        proposedDueTime: dueTime || null,
        proposedProcessorName: processor.proposedProcessorName,
        processorStatus: processor.processorStatus,
        processorMessage: processor.processorMessage,
        c4cProcessorUUID: processor.c4cProcessorUUID,
        c4cProcessorBPID: processor.c4cProcessorBPID,
        c4cProcessorName: processor.c4cProcessorName
      })
      await bumpDraft(session, draft)

      const result = { taskId: taskID, processorStatus: processor.processorStatus }
      if (processor.processorStatus === 'VALID' && processor.c4cProcessorName) result.processorName = processor.c4cProcessorName
      if (processor.matches.length) result.matches = processor.matches
      if (processor.processorMessage) result.processorMessage = processor.processorMessage

      const message = processor.processorStatus === 'AMBIGUOUS'
        ? 'Task draft added, but processor is ambiguous. Ask the user to specify the full name and call updateTaskDraft.'
        : processor.processorStatus === 'INVALID'
          ? 'Task draft added, but processor could not be resolved. Ask the user for the correct name and call updateTaskDraft.'
          : 'Task draft added.'
      return ok('TASK_ADDED', message, result)
    })

    this.on('updateTaskDraft', async (req) => {
      const { taskId, subject, description, dueDate, dueTime, processorName } = req.data
      const { session, draft } = await loadSessionWithVisit(req)
      if (!session) return
      if (!draft) return fail('NO_VISIT_SELECTED', 'Call findVisit and selectVisit first.')
      if (!['VISIT_SELECTED', 'PREVIEW'].includes(session.status)) {
        return fail('SESSION_STATE_INVALID', 'Tasks cannot be updated in the current session state.')
      }
      if (!taskId) return fail('TASK_ID_REQUIRED', 'Provide the taskId from addTaskDraft.')
      const task = await SELECT.one.from(TaskDrafts).where({ ID: taskId, visitDraft_ID: draft.ID })
      if (!task) return fail('TASK_NOT_FOUND', 'Task draft not found in this session. Use only task IDs returned by addTaskDraft.')

      const updates = {}
      if (subject !== undefined && subject !== null) {
        const s = String(subject).trim()
        if (!s) return fail('SUBJECT_REQUIRED', 'A task subject is required.')
        if (s.length > 765) return fail('SUBJECT_TOO_LONG', 'Task subject must be at most 765 characters.')
        updates.proposedSubject = s
      }
      if (description !== undefined) updates.proposedDescription = description ?? null
      if (dueDate !== undefined) updates.proposedDueDate = dueDate ?? null
      if (dueTime !== undefined) {
        if (dueTime && !isDueTime(dueTime)) return fail('INVALID_TIME_FORMAT', 'dueTime must be in HH:mm format, e.g. "14:30".')
        if (dueTime && !(dueDate ?? task.proposedDueDate)) return fail('DUE_DATE_REQUIRED', 'A due time needs a due date. Ask the user for the date.')
        updates.proposedDueTime = dueTime || null
      }

      let processor = null
      if (processorName !== undefined) {
        processor = await resolveProcessor(processorName, session)
        updates.proposedProcessorName = processor.proposedProcessorName
        updates.processorStatus = processor.processorStatus
        updates.processorMessage = processor.processorMessage
        updates.c4cProcessorUUID = processor.c4cProcessorUUID
        updates.c4cProcessorBPID = processor.c4cProcessorBPID
        updates.c4cProcessorName = processor.c4cProcessorName
      }

      if (Object.keys(updates).length) {
        await bumpDraft(session, draft)
        await UPDATE(TaskDrafts, task.ID).with(updates)
      }

      const currentStatus = processor?.processorStatus ?? task.processorStatus
      const result = { taskId: task.ID, processorStatus: currentStatus }
      if (processor?.matches?.length) result.matches = processor.matches
      if (processor?.processorMessage) result.processorMessage = processor.processorMessage
      if (currentStatus === 'VALID') result.processorName = processor?.c4cProcessorName ?? task.c4cProcessorName

      const message = currentStatus === 'AMBIGUOUS'
        ? 'Task updated, but processor is still ambiguous. Provide the full name and call updateTaskDraft again.'
        : currentStatus === 'INVALID'
          ? 'Task updated, but processor could not be resolved. Provide a correct name and call updateTaskDraft again.'
          : 'Task draft updated.'
      return ok('TASK_UPDATED', message, result)
    })

    this.on('removeTaskDraft', async (req) => {
      const { taskId } = req.data
      const { session, draft } = await loadSessionWithVisit(req)
      if (!session) return
      if (!draft) return fail('NO_VISIT_SELECTED', 'Call findVisit and selectVisit first.')
      if (!['VISIT_SELECTED', 'PREVIEW'].includes(session.status)) {
        return fail('SESSION_STATE_INVALID', 'Tasks cannot be removed in the current session state.')
      }
      if (!taskId) return fail('TASK_ID_REQUIRED', 'Provide the taskId from addTaskDraft.')
      const task = await SELECT.one.from(TaskDrafts).where({ ID: taskId, visitDraft_ID: draft.ID })
      if (!task) return fail('TASK_NOT_FOUND', 'Task draft not found in this session.')

      await DELETE.from(TaskDrafts).where({ ID: taskId })
      await bumpDraft(session, draft)
      return ok('TASK_REMOVED', 'Task draft removed.', { taskId })
    })

    return super.init()
  }
}
