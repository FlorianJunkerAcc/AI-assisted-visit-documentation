// Phase 2 – C4C read access: user mapping, Visit identification, Visit context, employee resolution.
// C4C is replaced by test/mocks/c4c-mock.js (fictional data). Run: npm test
import cds from '@sap/cds'
import { describe, it, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { installC4CMock, resetFixtures, addEmployee, addVisit, fixtures, calls } from './mocks/c4c-mock.js'
import { localDayRangeUtc } from '../srv/lib/time.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
cds.test(root)
const { SELECT } = cds.ql

const TZ = 'Europe/Berlin'
const ALICE = 'alice.sales@example.com'
const alice = new cds.User({ id: 'alice', roles: ['VisitDocumenter'], attr: { email: ALICE } })
const dave = new cds.User({ id: 'dave', roles: ['VisitDocumenter'], attr: { email: 'dave.unknown@example.com' } })

const HOUR = 3600 * 1000
const today = () => localDayRangeUtc(TZ)
const todayAt = (h) => new Date(today().start.getTime() + h * HOUR)

async function call (user, action, data = {}) {
  const srv = await cds.connect.to('VoiceAssistantService')
  return srv.tx({ user }, (tx) => tx.send(action, data))
}
const data = (res) => JSON.parse(res.data ?? 'null')
const start = async (user = alice) => data(await call(user, 'startSession', { timeZone: TZ, language: 'de' })).sessionId

before(() => installC4CMock())
beforeEach(() => {
  resetFixtures()
  addEmployee({ firstName: 'Alice', lastName: 'Sales', email: ALICE })
})

describe('Phase 2 – time zone helpers', () => {
  it('computes the local day in UTC (winter time)', () => {
    const { start, end } = localDayRangeUtc('Europe/Berlin', new Date('2026-11-17T10:00:00Z'))
    assert.equal(start.toISOString(), '2026-11-16T23:00:00.000Z')
    assert.equal(end.toISOString(), '2026-11-17T23:00:00.000Z')
  })
  it('handles the daylight-saving switch day (23 h)', () => {
    const { start, end } = localDayRangeUtc('Europe/Berlin', new Date('2026-03-29T12:00:00Z'))
    assert.equal(start.toISOString(), '2026-03-28T23:00:00.000Z')
    assert.equal(end.toISOString(), '2026-03-29T22:00:00.000Z')
  })
})

describe('Phase 2 – user mapping', () => {
  it('rejects a login whose e-mail is not an active C4C employee', async () => {
    const res = await call(dave, 'startSession', { timeZone: TZ })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'USER_NOT_IN_C4C')
    const { VoiceSessions } = cds.entities('voice')
    assert.equal((await SELECT.from(VoiceSessions).where({ userId: 'dave' })).length, 0)
  })

  it('rejects a locked employee', async () => {
    resetFixtures()
    addEmployee({ firstName: 'Alice', lastName: 'Sales', email: ALICE, locked: true })
    const res = await call(alice, 'startSession', { timeZone: TZ })
    assert.equal(res.code, 'USER_NOT_IN_C4C')
  })

  it('rejects an ambiguous e-mail (two active employees)', async () => {
    addEmployee({ firstName: 'Alice', lastName: 'Duplicate', email: ALICE })
    const res = await call(alice, 'startSession', { timeZone: TZ })
    assert.equal(res.code, 'USER_NOT_IN_C4C')
  })
})

describe('Phase 2 – findVisit', () => {
  it('aborts with NO_VISIT when nothing matches and blocks the session', async () => {
    addVisit({ subject: 'Other user', account: 'Acme', start: todayAt(9), end: todayAt(10), owner: 'someone@example.com' })
    addVisit({ subject: 'Already in process', account: 'Acme', start: todayAt(9), end: todayAt(10), owner: ALICE, status: '2' })
    addVisit({ subject: 'Deleted', account: 'Acme', start: todayAt(9), end: todayAt(10), owner: ALICE, deleted: true })
    addVisit({ subject: 'Yesterday', account: 'Acme', start: todayAt(-15), end: todayAt(-14), owner: ALICE })
    addVisit({ subject: 'Tomorrow', account: 'Acme', start: todayAt(33), end: todayAt(34), owner: ALICE })

    const sessionId = await start()
    const res = await call(alice, 'findVisit', { sessionId })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'NO_VISIT')
    assert.match(res.message, /created in SAP Sales Cloud/)

    const { VoiceSessions } = cds.entities('voice')
    assert.equal((await SELECT.one.from(VoiceSessions, sessionId)).status, 'NO_VISIT')
    await assert.rejects(call(alice, 'findVisit', { sessionId }), /SESSION_NO_VISIT/)
  })

  it('finds exactly one Visit where the user is owner', async () => {
    addVisit({ subject: 'Jahresgespräch', account: 'Beispiel GmbH', start: todayAt(10), end: todayAt(11), owner: ALICE })
    const sessionId = await start()
    const res = await call(alice, 'findVisit', { sessionId })
    assert.equal(res.code, 'VISIT_FOUND')
    const { candidates } = data(res)
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].account, 'Beispiel GmbH')
    assert.equal(candidates[0].startTime, '10:00')
  })

  it('finds a Visit where the user is only organizer, using two queries without "or"', async () => {
    addVisit({ subject: 'Workshop', account: 'Muster AG', start: todayAt(14), end: todayAt(15), owner: 'boss@example.com', organizer: ALICE })
    const sessionId = await start()
    const res = await call(alice, 'findVisit', { sessionId })
    assert.equal(res.code, 'VISIT_FOUND')
    const visitQueries = calls.filter(c => c.path.startsWith('/VisitCollection?'))
    assert.equal(visitQueries.length, 2)
    assert.ok(visitQueries.some(c => decodeURIComponent(c.path).includes('OwnerEmailURI eq')))
    assert.ok(visitQueries.some(c => decodeURIComponent(c.path).includes('OrganizerEmailURI eq')))
  })

  it('returns AMBIGUOUS for two Visits and does not select one', async () => {
    addVisit({ subject: 'A', account: 'Beispiel GmbH', start: todayAt(9), end: todayAt(10), owner: ALICE })
    addVisit({ subject: 'B', account: 'Muster AG', start: todayAt(14), end: todayAt(15), organizer: ALICE })
    const sessionId = await start()
    const res = await call(alice, 'findVisit', { sessionId })
    assert.equal(res.code, 'AMBIGUOUS')
    assert.deepEqual(data(res).candidates.map(c => c.account), ['Beispiel GmbH', 'Muster AG'])
    const { VisitDrafts } = cds.entities('voice')
    assert.equal((await SELECT.from(VisitDrafts).where({ session_ID: sessionId })).length, 0)
  })

  it('merges a Visit where the user is both owner and organizer into one candidate', async () => {
    addVisit({ subject: 'Both', account: 'Beispiel GmbH', start: todayAt(9), end: todayAt(10), owner: ALICE, organizer: ALICE })
    const sessionId = await start()
    const res = await call(alice, 'findVisit', { sessionId })
    assert.equal(res.code, 'VISIT_FOUND')
  })
})

describe('Phase 2 – selectVisit and getVisitContext', () => {
  it('selects a candidate, stores validated C4C data and returns the context', async () => {
    const v = addVisit({ subject: 'Jahresgespräch', account: 'Beispiel GmbH', start: todayAt(10), end: todayAt(11), owner: ALICE })
    const sessionId = await start()
    const { candidates } = data(await call(alice, 'findVisit', { sessionId }))

    const sel = await call(alice, 'selectVisit', { sessionId, visitObjectID: candidates[0].visitId })
    assert.equal(sel.code, 'VISIT_SELECTED')

    const { VisitDrafts, VoiceSessions } = cds.entities('voice')
    const draft = await SELECT.one.from(VisitDrafts).where({ session_ID: sessionId })
    assert.equal(draft.c4cVisitObjectID, v.ObjectID)
    assert.equal(draft.c4cVisitID, v.ID)
    assert.equal(draft.c4cAccountUUID, v.Account)
    assert.ok(draft.c4cVisitETag)
    assert.equal((await SELECT.one.from(VoiceSessions, sessionId)).status, 'VISIT_SELECTED')

    const ctx = await call(alice, 'getVisitContext', { sessionId })
    assert.equal(ctx.code, 'VISIT_CONTEXT')
    assert.equal(data(ctx).primaryContact, 'Erika Beispiel')
  })

  it('rejects a visitId that findVisit did not return', async () => {
    addVisit({ subject: 'Mine', account: 'Beispiel GmbH', start: todayAt(10), end: todayAt(11), owner: ALICE })
    const foreign = addVisit({ subject: 'Not mine', account: 'X', start: todayAt(10), end: todayAt(11), owner: 'x@example.com' })
    const sessionId = await start()
    await call(alice, 'findVisit', { sessionId })
    const res = await call(alice, 'selectVisit', { sessionId, visitObjectID: foreign.ObjectID })
    assert.equal(res.code, 'NOT_A_CANDIDATE')
  })

  it('re-checks C4C on selection (Visit closed in the meantime)', async () => {
    const v = addVisit({ subject: 'Mine', account: 'Beispiel GmbH', start: todayAt(10), end: todayAt(11), owner: ALICE })
    const sessionId = await start()
    const { candidates } = data(await call(alice, 'findVisit', { sessionId }))
    fixtures.visits.find(x => x.ObjectID === v.ObjectID).Status = '3'
    const res = await call(alice, 'selectVisit', { sessionId, visitObjectID: candidates[0].visitId })
    assert.equal(res.code, 'VISIT_NOT_OPEN')
  })

  it('requires a selected Visit for getVisitContext', async () => {
    const sessionId = await start()
    const res = await call(alice, 'getVisitContext', { sessionId })
    assert.equal(res.code, 'NO_VISIT_SELECTED')
  })
})

describe('Phase 2 – resolveEmployee', () => {
  async function sessionWithVisit () {
    addVisit({ subject: 'Mine', account: 'Beispiel GmbH', start: todayAt(10), end: todayAt(11), owner: ALICE })
    const sessionId = await start()
    const { candidates } = data(await call(alice, 'findVisit', { sessionId }))
    await call(alice, 'selectVisit', { sessionId, visitObjectID: candidates[0].visitId })
    return sessionId
  }

  it('finds exactly one active colleague by first name', async () => {
    addEmployee({ firstName: 'Patrick', lastName: 'Muster', email: 'p.muster@example.com' })
    const sessionId = await sessionWithVisit()
    const res = await call(alice, 'resolveEmployee', { sessionId, name: 'Patrick' })
    assert.equal(res.code, 'EMPLOYEE_FOUND')
    assert.deepEqual(data(res).matches, [{ name: 'Patrick Muster' }])
  })

  it('returns AMBIGUOUS for two colleagues with the same first name and resolves with the full name', async () => {
    addEmployee({ firstName: 'Patrick', lastName: 'Muster', email: 'p.muster@example.com' })
    addEmployee({ firstName: 'Patrick', lastName: 'Beispiel', email: 'p.beispiel@example.com' })
    const sessionId = await sessionWithVisit()
    const amb = await call(alice, 'resolveEmployee', { sessionId, name: 'Patrick' })
    assert.equal(amb.code, 'AMBIGUOUS')
    assert.equal(data(amb).matches.length, 2)
    const one = await call(alice, 'resolveEmployee', { sessionId, name: 'Patrick Beispiel' })
    assert.equal(one.code, 'EMPLOYEE_FOUND')
  })

  it('ignores locked employees and employees without a valid user', async () => {
    addEmployee({ firstName: 'Patrick', lastName: 'Gesperrt', email: 'p.g@example.com', locked: true })
    addEmployee({ firstName: 'Patrick', lastName: 'OhneUser', email: 'p.o@example.com', userValid: false })
    const sessionId = await sessionWithVisit()
    const res = await call(alice, 'resolveEmployee', { sessionId, name: 'Patrick' })
    assert.equal(res.code, 'EMPLOYEE_NOT_FOUND')
  })

  it('requires a selected Visit', async () => {
    const sessionId = await start()
    const res = await call(alice, 'resolveEmployee', { sessionId, name: 'Patrick' })
    assert.equal(res.code, 'NO_VISIT_SELECTED')
  })
})
