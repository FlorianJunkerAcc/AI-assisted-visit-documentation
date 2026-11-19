// Phase 5 – confirmCommit runs C4C writes synchronously.
// C4C is replaced by test/mocks/c4c-mock.js (POST + PATCH now supported). Run: npm test
import cds from '@sap/cds'
import { describe, it, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { installC4CMock, resetFixtures, addEmployee, addVisit, created, fixtures } from './mocks/c4c-mock.js'
import { localDayRangeUtc } from '../srv/lib/time.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
cds.test(root)
const { SELECT } = cds.ql

const TZ = 'Europe/Berlin'
const ALICE = 'alice.sales@example.com'
const alice = new cds.User({ id: 'alice', roles: ['VisitDocumenter'], attr: { email: ALICE } })

const HOUR = 3600 * 1000
const today = () => localDayRangeUtc(TZ)
const todayAt = (h) => new Date(today().start.getTime() + h * HOUR)

async function call (user, action, data = {}) {
  const srv = await cds.connect.to('VoiceAssistantService')
  return srv.tx({ user }, (tx) => tx.send(action, data))
}
const data = (res) => JSON.parse(res.data ?? 'null')

before(() => installC4CMock())
beforeEach(() => {
  resetFixtures()
  addEmployee({ firstName: 'Alice', lastName: 'Sales', email: ALICE })
})

/** Creates a session in PREVIEW state (no tasks). Returns { sessionId, previewHash }. */
async function previewSession () {
  addVisit({ subject: 'Jahresgespräch', account: 'Beispiel GmbH', start: todayAt(9), end: todayAt(10), owner: ALICE })
  const srv = await cds.connect.to('VoiceAssistantService')
  const startRes = await srv.tx({ user: alice }, tx => tx.send('startSession', { timeZone: TZ, language: 'de' }))
  const sessionId = JSON.parse(startRes.data).sessionId
  const findRes = await srv.tx({ user: alice }, tx => tx.send('findVisit', { sessionId }))
  const { candidates } = JSON.parse(findRes.data)
  await srv.tx({ user: alice }, tx => tx.send('selectVisit', { sessionId, visitObjectID: candidates[0].visitId }))
  await call(alice, 'updateVisitDraft', { sessionId, summary: 'Jahresgespräch erfolgreich – Folgeauftrag erwartet.', usePlannedEnd: true })
  const previewRes = await call(alice, 'prepareCommitPreview', { sessionId })
  assert.equal(previewRes.code, 'COMMIT_PREVIEW', 'previewSession helper: prepareCommitPreview must succeed')
  return { sessionId, previewHash: data(previewRes).previewHash }
}

/** Creates a PREVIEW session with one task (with description + due date). */
async function previewSessionWithTask () {
  addEmployee({ firstName: 'Patrick', lastName: 'Muster', email: 'patrick.muster@example.com' })
  const { sessionId } = await previewSession()
  // addTaskDraft triggers bumpDraft → session reverts to VISIT_SELECTED
  const addRes = await call(alice, 'addTaskDraft', {
    sessionId,
    subject: 'Angebot erstellen',
    description: 'Detailliertes Angebot fuer Produkt X',
    dueDate: '2026-11-30',
    processorName: 'Patrick Muster'
  })
  assert.equal(addRes.code, 'TASK_ADDED', 'previewSessionWithTask helper: addTaskDraft must succeed')
  const previewRes = await call(alice, 'prepareCommitPreview', { sessionId })
  assert.equal(previewRes.code, 'COMMIT_PREVIEW', 'previewSessionWithTask helper: prepareCommitPreview must succeed')
  return { sessionId, previewHash: data(previewRes).previewHash }
}

// ---------------------------------------------------------------------------

describe('Phase 5 – confirmCommit (full commit, no tasks)', () => {
  it('returns COMMIT_COMPLETED and sets session status to COMPLETED', async () => {
    const { sessionId, previewHash } = await previewSession()
    const res = await call(alice, 'confirmCommit', { sessionId, previewHash, userUtterance: 'Ja, bitte speichern.' })

    assert.equal(res.ok, true)
    assert.equal(res.code, 'COMMIT_COMPLETED')

    const { VoiceSessions } = cds.entities('voice')
    const session = await SELECT.one.from(VoiceSessions).where({ ID: sessionId })
    assert.equal(session.status, 'COMPLETED')
  })

  it('creates all CommitOperations with SUCCEEDED status', async () => {
    const { sessionId, previewHash } = await previewSession()
    await call(alice, 'confirmCommit', { sessionId, previewHash, userUtterance: 'Ja.' })

    const { CommitOperations } = cds.entities('voice')
    const ops = await SELECT.from(CommitOperations).where({ session_ID: sessionId })

    assert.ok(ops.length >= 4, 'at least ATTACH_SUMMARY_PDF, ATTACH_TRANSCRIPT_PDF, UPDATE_VISIT_END, UPDATE_VISIT_STATUS')
    const failed = ops.filter(o => o.status === 'FAILED')
    assert.equal(failed.length, 0, `no operations should fail; failed: ${JSON.stringify(failed)}`)
    const succeeded = ops.filter(o => o.status === 'SUCCEEDED')
    assert.equal(succeeded.length, ops.length)
  })

  it('attaches a summary PDF and a transcript PDF to the visit', async () => {
    const { sessionId, previewHash } = await previewSession()
    await call(alice, 'confirmCommit', { sessionId, previewHash, userUtterance: 'Ja.' })

    assert.equal(created.attachments.length, 2)
    const names = created.attachments.map(a => a.Name)
    assert.ok(names.some(n => n.includes('Besuchszusammenfassung')), `summary PDF must be attached; found: ${names}`)
    assert.ok(names.some(n => n.includes('Gespr')), `transcript PDF must be attached; found: ${names}`)
  })

  it('patches the visit end time and sets visit status to COMPLETED (3)', async () => {
    const { sessionId, previewHash } = await previewSession()

    // Remember which visit ObjectID was selected
    const { VisitDrafts } = cds.entities('voice')
    const draft = await SELECT.one.from(VisitDrafts).where({ session_ID: sessionId })
    const visitObjectID = draft.c4cVisitObjectID

    await call(alice, 'confirmCommit', { sessionId, previewHash, userUtterance: 'Ja.' })

    const visit = fixtures.visits.find(v => v.ObjectID === visitObjectID)
    assert.ok(visit.ActualEndDateTime, 'visit end time must be patched')
    assert.equal(visit.Status, '3', 'visit status must be COMPLETED (3)')
  })

  it('marks the CommitConfirmation as CONFIRMED', async () => {
    const { sessionId, previewHash } = await previewSession()
    await call(alice, 'confirmCommit', { sessionId, previewHash, userUtterance: 'Ja.' })

    const { CommitConfirmations } = cds.entities('voice')
    const conf = await SELECT.one.from(CommitConfirmations).where({ session_ID: sessionId, previewHash })
    assert.equal(conf.status, 'CONFIRMED')
    assert.ok(conf.confirmedAt)
  })
})

describe('Phase 5 – confirmCommit (full commit, with task)', () => {
  it('creates a C4C task with description text and visit link', async () => {
    const { sessionId, previewHash } = await previewSessionWithTask()
    await call(alice, 'confirmCommit', { sessionId, previewHash, userUtterance: 'Ja.' })

    assert.equal(created.tasks.length, 1)
    assert.equal(created.tasks[0].Subject, 'Angebot erstellen')

    assert.equal(created.taskTexts.length, 1, 'task description must be created')
    assert.equal(created.taskReferences.length, 1, 'task must be linked to the visit')
  })

  it('creates all CommitOperations with SUCCEEDED status when a task is present', async () => {
    const { sessionId, previewHash } = await previewSessionWithTask()
    await call(alice, 'confirmCommit', { sessionId, previewHash, userUtterance: 'Ja.' })

    const { CommitOperations } = cds.entities('voice')
    const ops = await SELECT.from(CommitOperations).where({ session_ID: sessionId })

    // 2 PDFs + CREATE_TASK + CREATE_TASK_TEXT + CREATE_TASK_LINK + UPDATE_VISIT_END + UPDATE_VISIT_STATUS = 7
    assert.ok(ops.length >= 7, `expected at least 7 ops; got ${ops.length}`)
    const failed = ops.filter(o => o.status === 'FAILED')
    assert.equal(failed.length, 0, `no operations should fail; failed: ${JSON.stringify(failed)}`)
  })

  it('stores the task ObjectID returned by C4C in the CREATE_TASK operation row', async () => {
    const { sessionId, previewHash } = await previewSessionWithTask()
    await call(alice, 'confirmCommit', { sessionId, previewHash, userUtterance: 'Ja.' })

    const { CommitOperations } = cds.entities('voice')
    const taskOp = await SELECT.one.from(CommitOperations).where({ session_ID: sessionId, kind: 'CREATE_TASK' })
    assert.ok(taskOp?.c4cObjectID, 'CREATE_TASK must store the returned ObjectID')
    assert.ok(taskOp?.c4cID, 'CREATE_TASK must store the returned ID')
  })
})
