import cds from '@sap/cds'
import { createHash } from 'node:crypto'
import { ok, fail } from './lib/tool-result.js'
import { isValidTimeZone, normaliseLanguage } from './lib/validation.js'
import * as c4c from './lib/c4c-client.js'
import { localDayRangeUtc, formatLocalTime, formatLocalDate, zonedTimeToUtc, localDate } from './lib/time.js'

const LOG = cds.log('voice')
const { SELECT, INSERT, UPDATE } = cds.ql

// Session states in which the conversation is finished; no tool may change anything anymore.
const FINAL_STATES = ['COMPLETED', 'PARTIAL_FAILURE', 'FAILED', 'CANCELLED', 'NO_VISIT']

// Tools that are defined in the service model but not implemented yet.
// They fail explicitly instead of pretending to work.
const NOT_YET_IMPLEMENTED = {
  addTaskDraft: 4,
  updateTaskDraft: 4,
  removeTaskDraft: 4
}

export default class VoiceAssistantService extends cds.ApplicationService {
  init () {
    const { VoiceSessions, VisitDrafts, TaskDrafts, CommitConfirmations, AuditLog } = cds.entities('voice')
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

    // --- draft (phase 3) -------------------------------------------------------------------------

    /** True iff the utterance is an unambiguous affirmation in German or English. */
    const isAffirmation = (utterance) => {
      const text = String(utterance ?? '').toLowerCase().normalize('NFC').trim()
      if (!text) return false
      if (/\b(nein|nicht|falsch|stopp|stop|abbrechen|cancel|no\b|don'?t|warte|wait|halt)\b/.test(text)) return false
      return /\b(ja\b|jep|jo\b|jup|genau|stimmt|richtig|korrekt|einverstanden|bestätig|okay|ok\b|super|perfekt|absolut|natürlich|yes|yeah|yep|yup|correct|right|confirm|perfect|good)\b/.test(text)
    }

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
      if (summary !== undefined && summary !== null) updates.proposedSummary = summary

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
          processorUUID: t.c4cProcessorUUID ?? ''
        }))
      })
      const previewHash = createHash('sha256').update(frozen).digest('hex')

      const isDE = session.language === 'de'
      const startTimeStr = formatLocalTime(session.timeZone, new Date(draft.c4cPlannedStart))
      const endTimeStr = formatLocalTime(session.timeZone, new Date(effectiveEnd))
      const visitDateStr = formatLocalDate(session.timeZone, new Date(draft.c4cPlannedStart))

      const taskLines = tasks.map((t, i) => isDE
        ? `  Aufgabe ${i + 1}: ${t.proposedSubject}${t.proposedProcessorName ? ` (Zuständig: ${t.proposedProcessorName})` : ''}`
        : `  Task ${i + 1}: ${t.proposedSubject}${t.proposedProcessorName ? ` (Assigned to: ${t.proposedProcessorName})` : ''}`)

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

      return ok('COMMIT_PREVIEW', 'Read this preview text to the user verbatim, then ask for explicit yes/no confirmation. Pass the hash to confirmCommit together with the user\'s utterance.', {
        previewHash,
        previewText
      })
    })

    this.on('confirmCommit', async (req) => {
      const { sessionId, previewHash, userUtterance } = req.data
      const session = await this.loadOwnSession(req, sessionId)
      if (!session) return
      if (session.status !== 'PREVIEW') {
        return fail('NOT_IN_PREVIEW', 'No commit preview is active. Call prepareCommitPreview first.')
      }

      const confirmation = await SELECT.one.from(CommitConfirmations)
        .where({ session_ID: sessionId, previewHash, status: 'PENDING' })
      if (!confirmation) {
        return fail('HASH_MISMATCH', 'The preview hash does not match the current preview. The draft may have changed. Call prepareCommitPreview again to get a fresh hash.')
      }

      if (!isAffirmation(userUtterance)) {
        return fail('NOT_CONFIRMED', 'The user utterance was not a clear confirmation. Ask again: "Möchten Sie speichern? Bitte antworten Sie mit Ja."')
      }

      await UPDATE(CommitConfirmations, confirmation.ID).with({
        status: 'CONFIRMED',
        confirmedAt: new Date().toISOString(),
        confirmationUtterance: String(userUtterance ?? '').slice(0, 500)
      })
      await UPDATE(VoiceSessions, session.ID).with({ status: 'COMMITTING' })
      await audit(req, 'COMMIT_CONFIRMED', { sessionId: session.ID, outcome: 'OK' })

      return ok('COMMIT_CONFIRMED', 'Confirmation accepted. The visit data will now be saved to SAP Sales Cloud. This may take a few seconds – do not hang up.')
    })

    // --- not yet implemented tools --------------------------------------------------------------

    for (const [action, phase] of Object.entries(NOT_YET_IMPLEMENTED)) {
      this.on(action, (req) => req.reject(501, `NOT_IMPLEMENTED: ${action} (planned for phase ${phase})`))
    }

    return super.init()
  }
}
