// Phase 4 – task drafts: addTaskDraft, updateTaskDraft, removeTaskDraft.
// C4C is replaced by test/mocks/c4c-mock.js (fictional data). Run: npm test
import cds from '@sap/cds'
import { describe, it, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { installC4CMock, resetFixtures, addEmployee, addVisit } from './mocks/c4c-mock.js'
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

/** Creates a session with one open visit selected. */
async function sessionWithVisit () {
  addVisit({ subject: 'Jahresgespräch', account: 'Beispiel GmbH', start: todayAt(9), end: todayAt(10), owner: ALICE })
  const srv = await cds.connect.to('VoiceAssistantService')
  const startRes = await srv.tx({ user: alice }, tx => tx.send('startSession', { timeZone: TZ, language: 'de' }))
  const sessionId = JSON.parse(startRes.data).sessionId
  const findRes = await srv.tx({ user: alice }, tx => tx.send('findVisit', { sessionId }))
  const { candidates } = JSON.parse(findRes.data)
  await srv.tx({ user: alice }, tx => tx.send('selectVisit', { sessionId, visitObjectID: candidates[0].visitId }))
  return sessionId
}

/** Creates a session with a visit selected and a summary + planned end already in the draft. */
async function draftedSession () {
  const sessionId = await sessionWithVisit()
  const res = await call(alice, 'updateVisitDraft', {
    sessionId,
    summary: 'Jahresgespräch erfolgreich – Folgeauftrag erwartet.',
    usePlannedEnd: true
  })
  assert.equal(res.code, 'VISIT_DRAFT_UPDATED', 'draftedSession helper: updateVisitDraft must succeed')
  return sessionId
}

/** Creates a session in PREVIEW state with no tasks; returns { sessionId, previewHash }. */
async function previewSession () {
  const sessionId = await draftedSession()
  const res = await call(alice, 'prepareCommitPreview', { sessionId })
  assert.equal(res.code, 'COMMIT_PREVIEW', 'previewSession helper: prepareCommitPreview must succeed')
  return { sessionId, previewHash: data(res).previewHash }
}

// --- addTaskDraft -------------------------------------------------------------------------------

describe('Phase 4 – addTaskDraft', () => {
  it('adds a task with a valid named processor', async () => {
    addEmployee({ firstName: 'Patrick', lastName: 'Muster', email: 'p.muster@example.com' })
    const sessionId = await sessionWithVisit()

    const res = await call(alice, 'addTaskDraft', {
      sessionId,
      subject: 'Angebot nachfassen',
      processorName: 'Patrick'
    })
    assert.equal(res.ok, true)
    assert.equal(res.code, 'TASK_ADDED')

    const d = data(res)
    assert.ok(d.taskId, 'taskId must be returned')
    assert.equal(d.processorStatus, 'VALID')
    assert.equal(d.processorName, 'Patrick Muster')

    const { TaskDrafts } = cds.entities('voice')
    const task = await SELECT.one.from(TaskDrafts).where({ ID: d.taskId })
    assert.ok(task, 'task must be persisted')
    assert.equal(task.proposedSubject, 'Angebot nachfassen')
    assert.ok(task.c4cProcessorUUID, 'processor UUID must be set')
    assert.equal(task.c4cProcessorName, 'Patrick Muster')
    assert.equal(task.processorStatus, 'VALID')
  })

  it('defaults to the current user as processor when no name is given', async () => {
    const sessionId = await sessionWithVisit()

    const res = await call(alice, 'addTaskDraft', { sessionId, subject: 'Folgeauftrag klären' })
    assert.equal(res.ok, true)
    assert.equal(data(res).processorStatus, 'VALID')

    const { TaskDrafts, VoiceSessions } = cds.entities('voice')
    const session = await SELECT.one.from(VoiceSessions).where({ ID: sessionId })
    const task = await SELECT.one.from(TaskDrafts).where({ ID: data(res).taskId })
    assert.equal(task.c4cProcessorUUID, session.c4cEmployeeUUID, 'processor must be the current user')
    assert.equal(task.c4cProcessorName, 'Alice Sales')
  })

  it('stores AMBIGUOUS status when multiple employees match the name', async () => {
    addEmployee({ firstName: 'Patrick', lastName: 'Muster', email: 'p.muster@example.com' })
    addEmployee({ firstName: 'Patrick', lastName: 'Duplikat', email: 'p.dup@example.com' })
    const sessionId = await sessionWithVisit()

    const res = await call(alice, 'addTaskDraft', {
      sessionId,
      subject: 'Aufgabe',
      processorName: 'Patrick'
    })
    assert.equal(res.ok, true)
    assert.equal(res.code, 'TASK_ADDED')

    const d = data(res)
    assert.equal(d.processorStatus, 'AMBIGUOUS')
    assert.ok(Array.isArray(d.matches) && d.matches.length >= 2, 'must return ambiguous matches')

    const { TaskDrafts } = cds.entities('voice')
    const task = await SELECT.one.from(TaskDrafts).where({ ID: d.taskId })
    assert.equal(task.processorStatus, 'AMBIGUOUS')
    assert.equal(task.c4cProcessorUUID, null)
  })

  it('stores INVALID status when no employee matches the name', async () => {
    const sessionId = await sessionWithVisit()

    const res = await call(alice, 'addTaskDraft', {
      sessionId,
      subject: 'Aufgabe',
      processorName: 'Unbekannte Person'
    })
    assert.equal(res.ok, true)
    assert.equal(res.code, 'TASK_ADDED')
    assert.equal(data(res).processorStatus, 'INVALID')
  })

  it('rejects when the subject is missing', async () => {
    const sessionId = await sessionWithVisit()
    const res = await call(alice, 'addTaskDraft', { sessionId })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'SUBJECT_REQUIRED')
  })

  it('bumps the draft version after adding a task', async () => {
    const sessionId = await sessionWithVisit()
    await call(alice, 'updateVisitDraft', { sessionId, summary: 'Test', usePlannedEnd: true })

    const { VisitDrafts } = cds.entities('voice')
    const before = await SELECT.one.from(VisitDrafts).where({ session_ID: sessionId })
    assert.equal(before.version, 2)

    await call(alice, 'addTaskDraft', { sessionId, subject: 'Aufgabe 1' })

    const after = await SELECT.one.from(VisitDrafts).where({ session_ID: sessionId })
    assert.equal(after.version, 3)
  })

  it('reverts PREVIEW state and supersedes the pending confirmation', async () => {
    const { sessionId } = await previewSession()

    const res = await call(alice, 'addTaskDraft', { sessionId, subject: 'Neue Aufgabe' })
    assert.equal(res.ok, true)

    const { VoiceSessions, CommitConfirmations } = cds.entities('voice')
    const session = await SELECT.one.from(VoiceSessions).where({ ID: sessionId })
    assert.equal(session.status, 'VISIT_SELECTED')

    const pendings = await SELECT.from(CommitConfirmations).where({ session_ID: sessionId, status: 'PENDING' })
    assert.equal(pendings.length, 0, 'no pending confirmation must remain after draft change')
  })
})

// --- updateTaskDraft ----------------------------------------------------------------------------

describe('Phase 4 – updateTaskDraft', () => {
  it('updates subject and description of an existing task', async () => {
    const sessionId = await sessionWithVisit()
    const addRes = await call(alice, 'addTaskDraft', { sessionId, subject: 'Original' })
    const { taskId } = data(addRes)

    const res = await call(alice, 'updateTaskDraft', {
      sessionId,
      taskId,
      subject: 'Überarbeitet',
      description: 'Neue Beschreibung'
    })
    assert.equal(res.ok, true)
    assert.equal(res.code, 'TASK_UPDATED')

    const { TaskDrafts } = cds.entities('voice')
    const task = await SELECT.one.from(TaskDrafts).where({ ID: taskId })
    assert.equal(task.proposedSubject, 'Überarbeitet')
    assert.equal(task.proposedDescription, 'Neue Beschreibung')
  })

  it('re-resolves the processor when processorName is provided', async () => {
    addEmployee({ firstName: 'Patrick', lastName: 'Muster', email: 'p.muster@example.com' })
    const sessionId = await sessionWithVisit()
    const addRes = await call(alice, 'addTaskDraft', { sessionId, subject: 'Aufgabe' })
    const { taskId } = data(addRes)

    const res = await call(alice, 'updateTaskDraft', { sessionId, taskId, processorName: 'Patrick' })
    assert.equal(res.ok, true)
    assert.equal(data(res).processorStatus, 'VALID')
    assert.equal(data(res).processorName, 'Patrick Muster')

    const { TaskDrafts } = cds.entities('voice')
    const task = await SELECT.one.from(TaskDrafts).where({ ID: taskId })
    assert.equal(task.c4cProcessorName, 'Patrick Muster')
    assert.equal(task.processorStatus, 'VALID')
  })

  it('rejects an unknown taskId', async () => {
    const sessionId = await sessionWithVisit()
    const res = await call(alice, 'updateTaskDraft', {
      sessionId,
      taskId: cds.utils.uuid(),
      subject: 'Test'
    })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'TASK_NOT_FOUND')
  })
})

// --- removeTaskDraft ----------------------------------------------------------------------------

describe('Phase 4 – removeTaskDraft', () => {
  it('removes an existing task from the draft', async () => {
    const sessionId = await sessionWithVisit()
    const addRes = await call(alice, 'addTaskDraft', { sessionId, subject: 'Aufgabe' })
    const { taskId } = data(addRes)

    const res = await call(alice, 'removeTaskDraft', { sessionId, taskId })
    assert.equal(res.ok, true)
    assert.equal(res.code, 'TASK_REMOVED')

    const { TaskDrafts } = cds.entities('voice')
    const task = await SELECT.one.from(TaskDrafts).where({ ID: taskId })
    assert.equal(task, null, 'task must be deleted from DB')
  })

  it('rejects an unknown taskId', async () => {
    const sessionId = await sessionWithVisit()
    const res = await call(alice, 'removeTaskDraft', {
      sessionId,
      taskId: cds.utils.uuid()
    })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'TASK_NOT_FOUND')
  })
})

// --- prepareCommitPreview with tasks ------------------------------------------------------------

describe('Phase 4 – prepareCommitPreview with tasks', () => {
  it('fails when a task has an unresolved processor', async () => {
    addEmployee({ firstName: 'Patrick', lastName: 'Muster', email: 'p.muster@example.com' })
    addEmployee({ firstName: 'Patrick', lastName: 'Duplikat', email: 'p.dup@example.com' })

    const sessionId = await draftedSession()
    await call(alice, 'addTaskDraft', {
      sessionId,
      subject: 'Aufgabe mit unklarem Zuständigen',
      processorName: 'Patrick'
    })

    const res = await call(alice, 'prepareCommitPreview', { sessionId })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'TASK_PROCESSOR_UNRESOLVED')
  })

  it('includes tasks in the commit preview text', async () => {
    addEmployee({ firstName: 'Patrick', lastName: 'Muster', email: 'p.muster@example.com' })

    const sessionId = await draftedSession()
    await call(alice, 'addTaskDraft', {
      sessionId,
      subject: 'Angebot nachfassen',
      processorName: 'Patrick'
    })

    const res = await call(alice, 'prepareCommitPreview', { sessionId })
    assert.equal(res.ok, true)
    assert.match(data(res).previewText, /Angebot nachfassen/)
    assert.match(data(res).previewText, /Patrick Muster/)
  })

  it('produces a different hash after a task is added', async () => {
    const { sessionId, previewHash: hash1 } = await previewSession()

    await call(alice, 'addTaskDraft', { sessionId, subject: 'Neue Aufgabe' })

    const res2 = await call(alice, 'prepareCommitPreview', { sessionId })
    assert.equal(res2.ok, true)
    assert.notEqual(data(res2).previewHash, hash1, 'hash must change when draft version changes')
  })
})
