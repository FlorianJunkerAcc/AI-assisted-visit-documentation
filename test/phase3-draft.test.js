// Phase 3 – visit draft update, commit preview and confirmation.
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

/** Creates a session that has had its preview prepared; returns { sessionId, previewHash }. */
async function previewSession () {
  const sessionId = await draftedSession()
  const res = await call(alice, 'prepareCommitPreview', { sessionId })
  assert.equal(res.code, 'COMMIT_PREVIEW', 'previewSession helper: prepareCommitPreview must succeed')
  return { sessionId, previewHash: data(res).previewHash }
}

// ---------------------------------------------------------------------------

describe('Phase 3 – updateVisitDraft', () => {
  it('stores a summary and the planned end time (usePlannedEnd)', async () => {
    const sessionId = await sessionWithVisit()
    const res = await call(alice, 'updateVisitDraft', {
      sessionId,
      summary: 'Produktpräsentation erfolgreich.',
      usePlannedEnd: true
    })
    assert.equal(res.ok, true)
    assert.equal(res.code, 'VISIT_DRAFT_UPDATED')

    const { VisitDrafts } = cds.entities('voice')
    const draft = await SELECT.one.from(VisitDrafts).where({ session_ID: sessionId })
    assert.equal(draft.proposedSummary, 'Produktpräsentation erfolgreich.')
    assert.ok(draft.proposedActualEnd, 'actualEnd must be set from planned end')
    assert.equal(draft.actualEndSource, 'PLANNED_FALLBACK')
    assert.equal(draft.version, 2)
  })

  it('increments the version on each call', async () => {
    const sessionId = await sessionWithVisit()
    await call(alice, 'updateVisitDraft', { sessionId, summary: 'First', usePlannedEnd: true })
    await call(alice, 'updateVisitDraft', { sessionId, summary: 'Second', usePlannedEnd: true })

    const { VisitDrafts } = cds.entities('voice')
    const draft = await SELECT.one.from(VisitDrafts).where({ session_ID: sessionId })
    assert.equal(draft.version, 3)
    assert.equal(draft.proposedSummary, 'Second')
  })

  it('rejects an invalid time format', async () => {
    const sessionId = await sessionWithVisit()
    for (const bad of ['25:00', '9:60', 'abc', '']) {
      const res = await call(alice, 'updateVisitDraft', { sessionId, summary: 'x', actualEndTime: bad })
      assert.equal(res.ok, false, `expected failure for "${bad}"`)
      assert.equal(res.code, 'INVALID_TIME_FORMAT', `expected INVALID_TIME_FORMAT for "${bad}"`)
    }
  })

  it('rejects a future end time (23:59 is almost always in the future)', async () => {
    const sessionId = await sessionWithVisit()
    const res = await call(alice, 'updateVisitDraft', { sessionId, summary: 'x', actualEndTime: '23:59' })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'ACTUAL_END_IN_FUTURE')
  })

  it('rejects conflicting end parameters', async () => {
    const sessionId = await sessionWithVisit()
    const res = await call(alice, 'updateVisitDraft', {
      sessionId,
      summary: 'x',
      actualEndTime: '10:00',
      usePlannedEnd: true
    })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'CONFLICTING_END_PARAMS')
  })

  it('requires a selected Visit', async () => {
    const srv = await cds.connect.to('VoiceAssistantService')
    const startRes = await srv.tx({ user: alice }, tx => tx.send('startSession', { timeZone: TZ, language: 'de' }))
    const sessionId = JSON.parse(startRes.data).sessionId
    const res = await call(alice, 'updateVisitDraft', { sessionId, summary: 'x', usePlannedEnd: true })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'NO_VISIT_SELECTED')
  })
})

describe('Phase 3 – prepareCommitPreview', () => {
  it('creates a 64-char SHA-256 hash and a German preview text, sets session to PREVIEW', async () => {
    const sessionId = await draftedSession()
    const res = await call(alice, 'prepareCommitPreview', { sessionId })
    assert.equal(res.ok, true)
    assert.equal(res.code, 'COMMIT_PREVIEW')

    const { previewHash, previewText } = data(res)
    assert.ok(previewHash && previewHash.length === 64, 'previewHash must be a 64-char hex string')
    assert.match(previewHash, /^[0-9a-f]{64}$/, 'previewHash must be lowercase hex')
    assert.ok(previewText.includes('Beispiel GmbH'), 'preview text must mention account name')
    assert.ok(previewText.includes('Jahresgespräch'), 'preview text must include the summary')
    assert.ok(previewText.includes('Bitte bestätigen'), 'German preview must end with confirmation prompt')

    const { VoiceSessions } = cds.entities('voice')
    const session = await SELECT.one.from(VoiceSessions).where({ ID: sessionId })
    assert.equal(session.status, 'PREVIEW')
  })

  it('stores a CommitConfirmation with PENDING status', async () => {
    const sessionId = await draftedSession()
    const res = await call(alice, 'prepareCommitPreview', { sessionId })
    const { previewHash } = data(res)

    const { CommitConfirmations } = cds.entities('voice')
    const conf = await SELECT.one.from(CommitConfirmations).where({ session_ID: sessionId, previewHash })
    assert.ok(conf, 'CommitConfirmation must be created')
    assert.equal(conf.status, 'PENDING')
    assert.equal(conf.draftVersion, 2)
  })

  it('supersedes an existing PENDING confirmation when called again', async () => {
    const sessionId = await draftedSession()
    await call(alice, 'prepareCommitPreview', { sessionId })
    await call(alice, 'prepareCommitPreview', { sessionId })

    const { CommitConfirmations } = cds.entities('voice')
    const all = await SELECT.from(CommitConfirmations).where({ session_ID: sessionId })
    assert.equal(all.length, 2)
    const pending = all.filter(c => c.status === 'PENDING')
    const superseded = all.filter(c => c.status === 'SUPERSEDED')
    assert.equal(pending.length, 1)
    assert.equal(superseded.length, 1)
  })

  it('fails without a summary (SUMMARY_MISSING)', async () => {
    const sessionId = await sessionWithVisit()
    const res = await call(alice, 'prepareCommitPreview', { sessionId })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'SUMMARY_MISSING')
  })

  it('fails when no end time is available (END_TIME_MISSING)', async () => {
    const sessionId = await sessionWithVisit()
    // Write only a summary, no end time
    await call(alice, 'updateVisitDraft', { sessionId, summary: 'Nur Zusammenfassung' })
    // The visit was created with a planned end (todayAt(10)) → it should use that as fallback.
    // This test verifies the case where c4cPlannedEnd is null.
    // We simulate this by patching the draft directly.
    const { VisitDrafts } = cds.entities('voice')
    const draft = await SELECT.one.from(VisitDrafts).where({ session_ID: sessionId })
    await cds.ql.UPDATE(VisitDrafts, draft.ID).with({ c4cPlannedEnd: null, proposedActualEnd: null })

    const res = await call(alice, 'prepareCommitPreview', { sessionId })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'END_TIME_MISSING')
  })
})

describe('Phase 3 – confirmCommit', () => {
  it('accepts a clear German affirmation and sets the session to COMPLETED', async () => {
    const { sessionId, previewHash } = await previewSession()
    const res = await call(alice, 'confirmCommit', { sessionId, previewHash, userUtterance: 'Ja, bitte speichern.' })
    assert.equal(res.ok, true)
    assert.equal(res.code, 'COMMIT_COMPLETED')

    const { VoiceSessions, CommitConfirmations } = cds.entities('voice')
    const session = await SELECT.one.from(VoiceSessions).where({ ID: sessionId })
    assert.equal(session.status, 'COMPLETED')

    const conf = await SELECT.one.from(CommitConfirmations).where({ session_ID: sessionId, previewHash })
    assert.equal(conf.status, 'CONFIRMED')
    assert.ok(conf.confirmedAt)
    assert.equal(conf.confirmationUtterance, 'Ja, bitte speichern.')
  })

  it('accepts a clear English affirmation', async () => {
    const { sessionId, previewHash } = await previewSession()
    const res = await call(alice, 'confirmCommit', { sessionId, previewHash, userUtterance: 'Yes, that is correct.' })
    assert.equal(res.code, 'COMMIT_COMPLETED')
  })

  it('rejects a negation ("Nein")', async () => {
    const { sessionId, previewHash } = await previewSession()
    const res = await call(alice, 'confirmCommit', { sessionId, previewHash, userUtterance: 'Nein, das stimmt nicht.' })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'NOT_CONFIRMED')

    // Session must stay in PREVIEW so the user can try again
    const { VoiceSessions } = cds.entities('voice')
    const session = await SELECT.one.from(VoiceSessions).where({ ID: sessionId })
    assert.equal(session.status, 'PREVIEW')
  })

  it('rejects an unclear utterance ("Ich bin nicht sicher")', async () => {
    const { sessionId, previewHash } = await previewSession()
    const res = await call(alice, 'confirmCommit', { sessionId, previewHash, userUtterance: 'Ich bin nicht sicher.' })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'NOT_CONFIRMED')
  })

  it('rejects a wrong hash (HASH_MISMATCH)', async () => {
    const { sessionId } = await previewSession()
    const fakeHash = 'a'.repeat(64)
    const res = await call(alice, 'confirmCommit', { sessionId, previewHash: fakeHash, userUtterance: 'Ja' })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'HASH_MISMATCH')
  })

  it('fails when session is not in PREVIEW (NOT_IN_PREVIEW)', async () => {
    const sessionId = await draftedSession()
    const fakeHash = 'b'.repeat(64)
    const res = await call(alice, 'confirmCommit', { sessionId, previewHash: fakeHash, userUtterance: 'Ja' })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'NOT_IN_PREVIEW')
  })

  it('updateVisitDraft after preview reverts session to VISIT_SELECTED and supersedes the confirmation', async () => {
    const { sessionId, previewHash } = await previewSession()

    // Change the draft → preview is invalidated
    const updateRes = await call(alice, 'updateVisitDraft', {
      sessionId,
      summary: 'Aktualisierte Zusammenfassung.',
      usePlannedEnd: true
    })
    assert.equal(updateRes.code, 'VISIT_DRAFT_UPDATED')

    // Session should be back to VISIT_SELECTED
    const { VoiceSessions, CommitConfirmations } = cds.entities('voice')
    const session = await SELECT.one.from(VoiceSessions).where({ ID: sessionId })
    assert.equal(session.status, 'VISIT_SELECTED')

    // The old confirmation must be SUPERSEDED
    const conf = await SELECT.one.from(CommitConfirmations).where({ session_ID: sessionId, previewHash })
    assert.equal(conf.status, 'SUPERSEDED')

    // confirmCommit with old hash must fail: session is no longer in PREVIEW
    const commitRes = await call(alice, 'confirmCommit', { sessionId, previewHash, userUtterance: 'Ja' })
    assert.equal(commitRes.ok, false)
    assert.equal(commitRes.code, 'NOT_IN_PREVIEW')
  })

  it('new prepareCommitPreview after draft change produces a different hash', async () => {
    const { sessionId, previewHash: oldHash } = await previewSession()

    await call(alice, 'updateVisitDraft', {
      sessionId,
      summary: 'Neue Zusammenfassung.',
      usePlannedEnd: true
    })

    const newPreviewRes = await call(alice, 'prepareCommitPreview', { sessionId })
    assert.equal(newPreviewRes.code, 'COMMIT_PREVIEW')
    const { previewHash: newHash } = data(newPreviewRes)
    assert.notEqual(newHash, oldHash, 'hash must change when draft version changes')

    // Can confirm with new hash
    const confirmRes = await call(alice, 'confirmCommit', {
      sessionId,
      previewHash: newHash,
      userUtterance: 'Genau, speichern.'
    })
    assert.equal(confirmRes.code, 'COMMIT_COMPLETED')
  })
})
