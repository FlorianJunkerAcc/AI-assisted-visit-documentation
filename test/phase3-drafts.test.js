// Phase 3 – updateVisitDraft, prepareCommitPreview, confirmCommit
// Phase 4 – addTaskDraft, updateTaskDraft, removeTaskDraft
// C4C is replaced by test/mocks/c4c-mock.js (fictional data). Run: npm test
import cds from '@sap/cds'
import { describe, it, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { installC4CMock, resetFixtures, addEmployee, addVisit, fixtures } from './mocks/c4c-mock.js'
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

/** Starts a session, finds and selects a Visit; returns { sessionId, visitId }. */
async function sessionWithVisit () {
  const v = addVisit({ subject: 'Jahresgespräch', account: 'Beispiel GmbH', start: todayAt(10), end: todayAt(11), owner: ALICE })
  const sessionId = data(await call(alice, 'startSession', { timeZone: TZ, language: 'de' })).sessionId
  const { candidates } = data(await call(alice, 'findVisit', { sessionId }))
  await call(alice, 'selectVisit', { sessionId, visitObjectID: candidates[0].visitId })
  return { sessionId, visit: v }
}

/** Calls updateVisitDraft with a valid summary and planned end time. */
async function updateDraft (sessionId, overrides = {}) {
  return call(alice, 'updateVisitDraft', {
    sessionId,
    summary: 'Besprachen Q4-Ziele und nächste Schritte.',
    usePlannedEnd: true,
    ...overrides
  })
}

before(() => installC4CMock())
beforeEach(() => {
  resetFixtures()
  addEmployee({ firstName: 'Alice', lastName: 'Sales', email: ALICE })
})

// =============================================================================
describe('Phase 3 – updateVisitDraft', () => {
  it('stores summary and uses planned end time as fallback', async () => {
    const { sessionId } = await sessionWithVisit()
    const res = await updateDraft(sessionId)
    assert.equal(res.code, 'DRAFT_UPDATED')

    const { VisitDrafts } = cds.entities('voice')
    const draft = await SELECT.one.from(VisitDrafts).where({ session_ID: sessionId })
    assert.equal(draft.proposedSummary, 'Besprachen Q4-Ziele und nächste Schritte.')
    assert.equal(draft.actualEndSource, 'PLANNED_FALLBACK')
    assert.ok(draft.proposedActualEnd)
  })

  it('stores a user-stated end time in UTC', async () => {
    const { sessionId } = await sessionWithVisit()
    // Visit starts at todayAt(10) = local 11:00 (Berlin winter = UTC+1). End at local 11:30 = not in future.
    const res = await updateDraft(sessionId, { usePlannedEnd: false, actualEndTime: '11:30' })
    assert.equal(res.code, 'DRAFT_UPDATED')

    const { VisitDrafts } = cds.entities('voice')
    const draft = await SELECT.one.from(VisitDrafts).where({ session_ID: sessionId })
    assert.equal(draft.actualEndSource, 'USER_STATED')
    // 11:30 Berlin winter = 10:30 UTC
    assert.match(draft.proposedActualEnd, /T10:30:00/)
  })

  it('rejects an empty summary', async () => {
    const { sessionId } = await sessionWithVisit()
    const res = await updateDraft(sessionId, { summary: '   ' })
    assert.equal(res.code, 'SUMMARY_MISSING')
  })

  it('rejects an invalid time format', async () => {
    const { sessionId } = await sessionWithVisit()
    const res = await updateDraft(sessionId, { usePlannedEnd: false, actualEndTime: '25:00' })
    assert.equal(res.code, 'INVALID_END_TIME')
  })

  it('rejects an end time in the future', async () => {
    const { sessionId } = await sessionWithVisit()
    const res = await updateDraft(sessionId, { usePlannedEnd: false, actualEndTime: '23:59' })
    // 23:59 local today is in the future (tests run before 23:59)
    assert.equal(res.code, 'END_TIME_IN_FUTURE')
  })

  it('requires a selected visit', async () => {
    const sessionId = data(await call(alice, 'startSession', { timeZone: TZ })).sessionId
    const res = await updateDraft(sessionId)
    assert.equal(res.code, 'NO_VISIT_SELECTED')
  })

  it('supersedes a preview when the draft is updated', async () => {
    const { sessionId } = await sessionWithVisit()
    await updateDraft(sessionId)
    await call(alice, 'prepareCommitPreview', { sessionId })

    const { VoiceSessions } = cds.entities('voice')
    assert.equal((await SELECT.one.from(VoiceSessions, sessionId)).status, 'PREVIEW')

    // Update draft again → preview must be invalidated
    await updateDraft(sessionId, { summary: 'Geänderte Zusammenfassung.' })
    assert.equal((await SELECT.one.from(VoiceSessions, sessionId)).status, 'VISIT_SELECTED')

    const { CommitConfirmations } = cds.entities('voice')
    const confs = await SELECT.from(CommitConfirmations).where({ session_ID: sessionId })
    assert.ok(confs.every(c => c.status === 'SUPERSEDED'))
  })
})

// =============================================================================
describe('Phase 4 – addTaskDraft', () => {
  it('adds a task with an explicit, resolved processor', async () => {
    addEmployee({ firstName: 'Patrick', lastName: 'Muster', email: 'p.muster@example.com' })
    const { sessionId } = await sessionWithVisit()
    await updateDraft(sessionId)
    const res = await call(alice, 'addTaskDraft', {
      sessionId,
      subject: 'Angebot erstellen',
      description: 'Für Q4-Produkt.',
      dueDate: '2026-11-30',
      processorName: 'Patrick'
    })
    assert.equal(res.code, 'TASK_ADDED')
    const taskId = data(res).taskId

    const { TaskDrafts } = cds.entities('voice')
    const task = await SELECT.one.from(TaskDrafts).where({ ID: taskId })
    assert.equal(task.proposedSubject, 'Angebot erstellen')
    assert.equal(task.processorStatus, 'VALID')
    assert.ok(task.c4cProcessorUUID)
    assert.equal(task.proposedDueDate, '2026-11-30')
  })

  it('assigns the user as processor when no name is given', async () => {
    const { sessionId } = await sessionWithVisit()
    await updateDraft(sessionId)
    const res = await call(alice, 'addTaskDraft', { sessionId, subject: 'Follow-up' })
    assert.equal(res.code, 'TASK_ADDED')
    const { TaskDrafts } = cds.entities('voice')
    const { VoiceSessions } = cds.entities('voice')
    const session = await SELECT.one.from(VoiceSessions, sessionId)
    const task = await SELECT.one.from(TaskDrafts).where({ ID: data(res).taskId })
    assert.equal(task.processorStatus, 'VALID')
    assert.equal(task.c4cProcessorUUID, session.c4cEmployeeUUID)
  })

  it('stores AMBIGUOUS status when multiple employees match', async () => {
    addEmployee({ firstName: 'Patrick', lastName: 'A', email: 'pa@example.com' })
    addEmployee({ firstName: 'Patrick', lastName: 'B', email: 'pb@example.com' })
    const { sessionId } = await sessionWithVisit()
    await updateDraft(sessionId)
    const res = await call(alice, 'addTaskDraft', { sessionId, subject: 'x', processorName: 'Patrick' })
    assert.equal(data(res).processorStatus, 'AMBIGUOUS')
  })

  it('stores INVALID status when no employee matches', async () => {
    const { sessionId } = await sessionWithVisit()
    await updateDraft(sessionId)
    const res = await call(alice, 'addTaskDraft', { sessionId, subject: 'x', processorName: 'Unbekannt' })
    assert.equal(data(res).processorStatus, 'INVALID')
  })

  it('requires a selected visit', async () => {
    const sessionId = data(await call(alice, 'startSession', { timeZone: TZ })).sessionId
    const res = await call(alice, 'addTaskDraft', { sessionId, subject: 'x' })
    assert.equal(res.code, 'NO_VISIT_SELECTED')
  })
})

// =============================================================================
describe('Phase 4 – updateTaskDraft', () => {
  it('updates the subject and resolves the processor', async () => {
    addEmployee({ firstName: 'Patrick', lastName: 'Muster', email: 'p.muster@example.com' })
    const { sessionId } = await sessionWithVisit()
    await updateDraft(sessionId)
    const addRes = await call(alice, 'addTaskDraft', { sessionId, subject: 'Alt', processorName: 'Unbekannt' })
    const taskId = data(addRes).taskId

    const upd = await call(alice, 'updateTaskDraft', {
      sessionId,
      taskId,
      subject: 'Neu',
      processorName: 'Patrick'
    })
    assert.equal(upd.code, 'TASK_UPDATED')
    assert.equal(data(upd).processorStatus, 'VALID')

    const { TaskDrafts } = cds.entities('voice')
    const task = await SELECT.one.from(TaskDrafts).where({ ID: taskId })
    assert.equal(task.proposedSubject, 'Neu')
    assert.ok(task.c4cProcessorUUID)
  })

  it('rejects when task does not belong to this session', async () => {
    const { sessionId } = await sessionWithVisit()
    const res = await call(alice, 'updateTaskDraft', { sessionId, taskId: cds.utils.uuid() })
    assert.equal(res.code, 'TASK_NOT_FOUND')
  })
})

// =============================================================================
describe('Phase 4 – removeTaskDraft', () => {
  it('removes a task', async () => {
    const { sessionId } = await sessionWithVisit()
    await updateDraft(sessionId)
    const addRes = await call(alice, 'addTaskDraft', { sessionId, subject: 'Zu löschen' })
    const taskId = data(addRes).taskId

    const rem = await call(alice, 'removeTaskDraft', { sessionId, taskId })
    assert.equal(rem.code, 'TASK_REMOVED')

    const { TaskDrafts } = cds.entities('voice')
    assert.equal((await SELECT.from(TaskDrafts).where({ ID: taskId })).length, 0)
  })

  it('rejects when task does not belong to this session', async () => {
    const { sessionId } = await sessionWithVisit()
    const res = await call(alice, 'removeTaskDraft', { sessionId, taskId: cds.utils.uuid() })
    assert.equal(res.code, 'TASK_NOT_FOUND')
  })
})

// =============================================================================
describe('Phase 3 – prepareCommitPreview', () => {
  it('generates a preview hash and text, sets session to PREVIEW', async () => {
    const { sessionId } = await sessionWithVisit()
    await updateDraft(sessionId)
    const res = await call(alice, 'prepareCommitPreview', { sessionId })
    assert.equal(res.code, 'PREVIEW_READY')
    const { previewHash, previewText } = data(res)
    assert.ok(previewHash, 'hash must be non-empty')
    assert.match(previewText, /Beispiel GmbH/)
    assert.match(previewText, /Jahresgespräch/)
    assert.match(previewText, /Besprachen Q4/)
    assert.match(previewText, /Soll ich das so speichern/)

    const { VoiceSessions } = cds.entities('voice')
    assert.equal((await SELECT.one.from(VoiceSessions, sessionId)).status, 'PREVIEW')
  })

  it('includes task details in the preview text', async () => {
    addEmployee({ firstName: 'Patrick', lastName: 'Muster', email: 'p.muster@example.com' })
    const { sessionId } = await sessionWithVisit()
    await updateDraft(sessionId)
    await call(alice, 'addTaskDraft', { sessionId, subject: 'Angebot senden', processorName: 'Patrick' })

    const res = await call(alice, 'prepareCommitPreview', { sessionId })
    const { previewText } = data(res)
    assert.match(previewText, /Angebot senden/)
    assert.match(previewText, /Patrick Muster/)
  })

  it('rejects when summary is missing', async () => {
    const { sessionId } = await sessionWithVisit()
    const res = await call(alice, 'prepareCommitPreview', { sessionId })
    assert.equal(res.code, 'SUMMARY_MISSING')
  })

  it('rejects when a task has an unresolved processor', async () => {
    const { sessionId } = await sessionWithVisit()
    await updateDraft(sessionId)
    await call(alice, 'addTaskDraft', { sessionId, subject: 'x', processorName: 'Unbekannt' })
    const res = await call(alice, 'prepareCommitPreview', { sessionId })
    assert.equal(res.code, 'UNRESOLVED_PROCESSORS')
  })

  it('hash changes when the draft is updated', async () => {
    const { sessionId } = await sessionWithVisit()
    await updateDraft(sessionId)
    const hash1 = data(await call(alice, 'prepareCommitPreview', { sessionId })).previewHash
    await updateDraft(sessionId, { summary: 'Andere Zusammenfassung.' })
    const hash2 = data(await call(alice, 'prepareCommitPreview', { sessionId })).previewHash
    assert.notEqual(hash1, hash2)
  })
})

// =============================================================================
describe('Phase 3 – confirmCommit', () => {
  async function readyToConfirm () {
    const { sessionId } = await sessionWithVisit()
    await updateDraft(sessionId)
    const { previewHash } = data(await call(alice, 'prepareCommitPreview', { sessionId }))
    return { sessionId, previewHash }
  }

  it('commits successfully with a clear German confirmation', async () => {
    const { sessionId, previewHash } = await readyToConfirm()
    const res = await call(alice, 'confirmCommit', { sessionId, previewHash, userUtterance: 'Ja, bitte speichern.' })
    assert.equal(res.code, 'COMMITTED')

    const { VoiceSessions } = cds.entities('voice')
    assert.equal((await SELECT.one.from(VoiceSessions, sessionId)).status, 'COMPLETED')

    // Visit in mock must have been PATCH-ed to status '3' (Completed)
    const v = fixtures.visits[0]
    assert.equal(v.Status, '3')
    assert.ok(v.ActualEndDateTime, 'ActualEndDateTime must have been set')
  })

  it('commits successfully with a clear English confirmation', async () => {
    const { sessionId, previewHash } = await readyToConfirm()
    const res = await call(alice, 'confirmCommit', { sessionId, previewHash, userUtterance: 'Yes please' })
    assert.equal(res.code, 'COMMITTED')
  })

  it('creates task + text + BTD reference in C4C', async () => {
    addEmployee({ firstName: 'Patrick', lastName: 'Muster', email: 'p.muster@example.com' })
    const { sessionId } = await sessionWithVisit()
    await updateDraft(sessionId)
    await call(alice, 'addTaskDraft', { sessionId, subject: 'Nachfassen', description: 'Details klären.', processorName: 'Patrick' })
    const { previewHash } = data(await call(alice, 'prepareCommitPreview', { sessionId }))

    const res = await call(alice, 'confirmCommit', { sessionId, previewHash, userUtterance: 'ja' })
    assert.equal(res.code, 'COMMITTED')

    assert.equal(fixtures.tasks.length, 1)
    assert.equal(fixtures.tasks[0].Subject, 'Nachfassen')
    assert.equal(fixtures.taskTexts.length, 1)
    assert.equal(fixtures.taskTexts[0].Text, 'Details klären.')
    assert.equal(fixtures.taskBtdRefs.length, 1)
  })

  it('rejects a wrong hash', async () => {
    const { sessionId } = await readyToConfirm()
    const res = await call(alice, 'confirmCommit', { sessionId, previewHash: 'wrong', userUtterance: 'ja' })
    assert.equal(res.code, 'HASH_MISMATCH')
  })

  it('rejects a denial', async () => {
    const { sessionId, previewHash } = await readyToConfirm()
    const res = await call(alice, 'confirmCommit', { sessionId, previewHash, userUtterance: 'Nein, bitte nicht.' })
    assert.equal(res.code, 'DENIED')
    // Session must stay in PREVIEW state so the user can make corrections
    const { VoiceSessions } = cds.entities('voice')
    assert.equal((await SELECT.one.from(VoiceSessions, sessionId)).status, 'PREVIEW')
  })

  it('rejects an unclear utterance', async () => {
    const { sessionId, previewHash } = await readyToConfirm()
    const res = await call(alice, 'confirmCommit', { sessionId, previewHash, userUtterance: 'vielleicht' })
    assert.equal(res.code, 'UNCLEAR')
  })

  it('rejects when session is not in PREVIEW', async () => {
    const { sessionId } = await sessionWithVisit()
    await updateDraft(sessionId)
    // Skipped prepareCommitPreview → status is VISIT_SELECTED, not PREVIEW
    const res = await call(alice, 'confirmCommit', { sessionId, previewHash: 'any', userUtterance: 'ja' })
    assert.equal(res.code, 'NOT_IN_PREVIEW')
  })
})
