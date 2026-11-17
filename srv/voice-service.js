import cds from '@sap/cds'
import { ok, fail } from './lib/tool-result.js'
import { isValidTimeZone, normaliseLanguage } from './lib/validation.js'

const LOG = cds.log('voice')
const { SELECT, INSERT, UPDATE } = cds.ql

// Session states in which the conversation is finished; no tool may change anything anymore.
const FINAL_STATES = ['COMPLETED', 'PARTIAL_FAILURE', 'FAILED', 'CANCELLED', 'NO_VISIT']

// Tools that are defined in the service model but not implemented yet.
// They fail explicitly instead of pretending to work.
const NOT_YET_IMPLEMENTED = {
  findVisit: 2,
  selectVisit: 2,
  getVisitContext: 2,
  resolveEmployee: 2,
  updateVisitDraft: 3,
  addTaskDraft: 4,
  updateTaskDraft: 4,
  removeTaskDraft: 4,
  prepareCommitPreview: 3,
  confirmCommit: 3
}

export default class VoiceAssistantService extends cds.ApplicationService {
  init () {
    const { VoiceSessions, AuditLog } = cds.entities('voice')
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

      // NOTE: the mapping of the login e-mail for XSUAA (SAP ID Service) is verified in phase 2/9.
      const userEmail = req.user.attr?.email ?? null
      const ID = cds.utils.uuid()
      const expiresAt = new Date(Date.now() + retentionDays * 24 * 3600 * 1000).toISOString()

      await INSERT.into(VoiceSessions).entries({
        ID, userId: req.user.id, userEmail, timeZone, language: lang, status: 'ACTIVE', expiresAt
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

    // --- not yet implemented tools --------------------------------------------------------------

    for (const [action, phase] of Object.entries(NOT_YET_IMPLEMENTED)) {
      this.on(action, (req) => req.reject(501, `NOT_IMPLEMENTED: ${action} (planned for phase ${phase})`))
    }

    return super.init()
  }
}
