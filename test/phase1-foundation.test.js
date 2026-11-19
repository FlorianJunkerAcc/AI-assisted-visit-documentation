// Phase 1 – CAP foundation: data model, internal tool service, session ownership, audit.
// Run: npm test
import cds from '@sap/cds'
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { installC4CMock, addEmployee } from './mocks/c4c-mock.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { GET } = cds.test(root)
const { SELECT } = cds.ql

before(() => {
  installC4CMock()
  addEmployee({ firstName: 'Alice', lastName: 'Sales', email: 'alice.sales@example.com' })
  addEmployee({ firstName: 'Carol', lastName: 'Sales', email: 'carol.sales@example.com' })
})

const user = (id, roles, email) => new cds.User({ id, roles, attr: { email } })
const alice = user('alice', ['VisitDocumenter'], 'alice.sales@example.com')
const carol = user('carol', ['VisitDocumenter'], 'carol.sales@example.com')
const bob = user('bob', [], 'bob.nobody@example.com')

/** Calls an action of the internal service as the given user. */
async function call (asUser, action, data = {}) {
  const srv = await cds.connect.to('VoiceAssistantService')
  return srv.tx({ user: asUser }, (tx) => tx.send(action, data))
}

/** Asserts that a promise is rejected with the given HTTP status and message fragment. */
async function rejects (promise, status, messagePart) {
  let error
  try { await promise } catch (e) { error = e }
  assert.ok(error, `expected rejection with ${status} ${messagePart}`)
  const statuses = [error.status, error.statusCode, error.code].map(Number)
  assert.ok(statuses.includes(status), `expected status ${status}, got ${JSON.stringify({ status: error.status, statusCode: error.statusCode, code: error.code, message: error.message })}`)
  if (messagePart) assert.match(error.message, new RegExp(messagePart))
}

describe('Phase 1 – data model', () => {
  it('contains all application entities', () => {
    const e = cds.entities('voice')
    for (const name of ['VoiceSessions', 'TranscriptEntries', 'VisitDrafts', 'TaskDrafts', 'CommitConfirmations', 'CommitOperations', 'AuditLog']) {
      assert.ok(e[name], `entity voice.${name} missing`)
    }
  })

  it('keeps AI-proposed and C4C-validated task fields apart', () => {
    const { TaskDrafts } = cds.entities('voice')
    const names = Object.keys(TaskDrafts.elements)
    assert.ok(names.includes('proposedProcessorName'))
    assert.ok(names.includes('c4cProcessorUUID'))
  })
})

describe('Phase 1 – tool service is internal only', () => {
  it('is not reachable over HTTP', async () => {
    for (const path of ['/odata/v4/voice-assistant/$metadata', '/rest/voice-assistant/startSession']) {
      let status
      try { const res = await GET(path, { auth: { username: 'alice', password: 'alice' } }); status = res.status } catch (e) { status = e.response?.status ?? e.status }
      assert.equal(status, 404, `${path} must not be served`)
    }
  })

  it('requires the role VisitDocumenter', async () => {
    await rejects(call(bob, 'startSession', { timeZone: 'Europe/Berlin' }), 403)
  })
})

describe('Phase 1 – sessions', () => {
  it('starts a session for the current user', async () => {
    const res = await call(alice, 'startSession', { timeZone: 'Europe/Berlin', language: 'de' })
    assert.equal(res.ok, true)
    assert.equal(res.code, 'SESSION_STARTED')
    const { sessionId } = JSON.parse(res.data)

    const { VoiceSessions, AuditLog } = cds.entities('voice')
    const s = await SELECT.one.from(VoiceSessions).where({ ID: sessionId })
    assert.equal(s.userId, 'alice')
    assert.equal(s.userEmail, 'alice.sales@example.com')
    assert.ok(s.c4cEmployeeUUID, 'C4C employee UUID of the user is stored')
    assert.equal(s.status, 'ACTIVE')
    const days = (new Date(s.expiresAt) - Date.now()) / 86400000
    assert.ok(days > 6.9 && days <= 7, `expiresAt should be ~7 days ahead, is ${days}`)

    const log = await SELECT.from(AuditLog).where({ sessionId, event: 'SESSION_STARTED' })
    assert.equal(log.length, 1)
  })

  it('rejects an invalid time zone and an unsupported language', async () => {
    await rejects(call(alice, 'startSession', { timeZone: 'Mars/Olympus' }), 400, 'INVALID_TIME_ZONE')
    await rejects(call(alice, 'startSession', { timeZone: 'Europe/Berlin', language: 'fr' }), 400, 'UNSUPPORTED_LANGUAGE')
  })

  it('does not let another user access the session', async () => {
    const res = await call(alice, 'startSession', { timeZone: 'Europe/Berlin' })
    const { sessionId } = JSON.parse(res.data)
    await rejects(call(carol, 'cancelSession', { sessionId }), 404, 'SESSION_NOT_FOUND')
  })

  it('cancels a session and blocks further tool calls', async () => {
    const res = await call(alice, 'startSession', { timeZone: 'Europe/Berlin' })
    const { sessionId } = JSON.parse(res.data)
    const cancelled = await call(alice, 'cancelSession', { sessionId })
    assert.equal(cancelled.code, 'SESSION_CANCELLED')
    await rejects(call(alice, 'cancelSession', { sessionId }), 409, 'SESSION_CANCELLED')
  })
})

describe('Phase 1 – placeholders are explicit', () => {
  it('tools of later phases fail with 501 instead of pretending to work', async () => {
    const res = await call(alice, 'startSession', { timeZone: 'Europe/Berlin' })
    const { sessionId } = JSON.parse(res.data)
    await rejects(call(alice, 'addTaskDraft', { sessionId }), 501, 'NOT_IMPLEMENTED: addTaskDraft')
    await rejects(call(alice, 'updateTaskDraft', { sessionId }), 501, 'NOT_IMPLEMENTED: updateTaskDraft')
  })
})
