// In-memory C4C mock for tests. It emulates only the queries the app sends:
//   GET /<EntitySet>?$filter=<clause> and <clause> ...   (eq, ge, lt; "or" is rejected like real C4C)
//   GET /<EntitySet>('<ObjectID>')
//   PATCH /<EntitySet>('<ObjectID>')                     (If-Match required, 412 on mismatch)
//   POST /<EntitySet>                                    (creates row with generated ObjectID/ID)
// Responses use the raw OData V2 shape { d: { results: [...] } } with "/Date(ms)/" values.
// All names and e-mails are fictional.
import { setTransport } from '../../srv/lib/c4c-client.js'

const odataDate = (d) => (d ? `/Date(${new Date(d).getTime()})/` : null)

export const fixtures = { visits: [], employees: [], tasks: [], taskTexts: [], taskBtdRefs: [] }
export const calls = []
export const created = { tasks: [], taskTexts: [], taskReferences: [], attachments: [] }

export function resetFixtures () {
  fixtures.visits = []
  fixtures.employees = []
  fixtures.tasks = []
  fixtures.taskTexts = []
  fixtures.taskBtdRefs = []
  calls.length = 0
  created.tasks = []
  created.taskTexts = []
  created.taskReferences = []
  created.attachments = []
}

let objCounter = 0
const objectId = () => (objCounter++).toString(16).toUpperCase().padStart(32, 'A')

export function addEmployee ({ firstName, lastName, email, locked = false, userValid = true }) {
  const uuid = `00000000-0000-0000-0000-${String(fixtures.employees.length + 1).padStart(12, '0')}`
  const e = {
    ObjectID: objectId(),
    UUID: uuid,
    EmployeeID: `E${fixtures.employees.length + 1}`,
    BusinessPartnerID: String(8000000000 + fixtures.employees.length + 1),
    BusinessPartnerFormattedName: `${firstName} ${lastName}`,
    FirstName: firstName,
    LastName: lastName,
    Email: email,
    EmployeeValidityStartDate: odataDate('2020-01-01'),
    EmployeeValidityEndDate: odataDate('9999-12-31'),
    UserValidityStartDate: userValid ? odataDate('2020-01-01') : null,
    UserValidityEndDate: userValid ? odataDate('9999-12-31') : null,
    UserLockedIndicator: locked
  }
  fixtures.employees.push(e)
  return e
}

export function addVisit ({ subject, account, start, end, owner, organizer, status = '1', deleted = false }) {
  const v = {
    __metadata: { etag: `W/"datetimeoffset'2026-11-17T08%3A00%3A00.0000000Z'"` },
    ObjectID: objectId(),
    ID: String(2000 + fixtures.visits.length + 1),
    Subject: subject,
    Status: status,
    StartDateTime: odataDate(start),
    EndDateTime: odataDate(end),
    Account: `00163EB0-0000-0000-0000-${String(fixtures.visits.length + 1).padStart(12, '0')}`,
    AccountName: account,
    AccountPartyName: account,
    MainAccountPartyID: String(1000000 + fixtures.visits.length + 1),
    PrimaryContactPartyName: 'Erika Beispiel',
    Location: 'Beispielstraße 1, Musterstadt',
    OwnerEmailURI: owner ?? null,
    OrganizerEmailURI: organizer ?? null,
    MarkedForDeletion: deleted
  }
  fixtures.visits.push(v)
  return v
}

// --- tiny $filter evaluator --------------------------------------------------------------------

function parseValue (raw) {
  let m
  if ((m = /^'(.*)'$/s.exec(raw))) return { kind: 'string', value: m[1].replace(/''/g, "'") }
  if ((m = /^datetimeoffset'(.*)'$/.exec(raw))) return { kind: 'date', value: new Date(m[1]).getTime() }
  throw Object.assign(new Error(`mock: unsupported literal ${raw}`), { status: 400 })
}

function toComparable (fieldValue, kind) {
  if (kind === 'date') {
    const m = /^\/Date\((-?\d+)\)\/$/.exec(fieldValue ?? '')
    return m ? Number(m[1]) : null
  }
  return fieldValue
}

function compileFilter (filter) {
  if (/\sor\s/i.test(filter)) {
    throw Object.assign(new Error('mock C4C: "or" across properties is not supported'), { status: 400 })
  }
  const clauses = filter.split(/\s+and\s+/).map(c => {
    const m = /^(\w+)\s+(eq|ge|lt)\s+(.+)$/.exec(c.trim())
    if (!m) throw Object.assign(new Error(`mock: unsupported clause ${c}`), { status: 400 })
    return { prop: m[1], op: m[2], ...parseValue(m[3].trim()) }
  })
  return (row) => clauses.every(({ prop, op, kind, value }) => {
    const v = toComparable(row[prop], kind)
    if (v === null || v === undefined) return false
    if (op === 'eq') return v === value
    if (op === 'ge') return v >= value
    if (op === 'lt') return v < value
    return false
  })
}

const sets = {
  VisitCollection: () => fixtures.visits,
  EmployeeCollection: () => fixtures.employees,
  TasksCollection: () => fixtures.tasks,
  TasksTextCollection: () => fixtures.taskTexts,
  TasksBTDReferenceCollection: () => fixtures.taskBtdRefs
}

async function mockTransport ({ method, path, data, headers }) {
  calls.push({ method, path })

  const [resource, query = ''] = path.replace(/^\//, '').split('?')

  if (method === 'GET') {
    const params = Object.fromEntries(query.split('&').filter(Boolean).map(p => {
      const i = p.indexOf('=')
      return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))]
    }))
    const byKey = /^(\w+)\('([0-9A-Fa-f]+)'\)$/.exec(resource)
    if (byKey) {
      const row = sets[byKey[1]]?.().find(r => r.ObjectID === byKey[2])
      if (!row) throw Object.assign(new Error('mock: not found'), { status: 404 })
      return { d: row }
    }
    const rows = sets[resource]?.()
    if (!rows) throw Object.assign(new Error(`mock: unknown resource ${resource}`), { status: 404 })
    const filtered = params.$filter ? rows.filter(compileFilter(params.$filter)) : rows
    return { d: { results: filtered.slice(0, Number(params.$top ?? 1000)) } }
  }

  if (method === 'PATCH') {
    const byKey = /^(\w+)\('([0-9A-Fa-f]+)'\)$/.exec(resource)
    if (!byKey) throw Object.assign(new Error('mock: PATCH requires a key'), { status: 400 })
    const rows = sets[byKey[1]]?.()
    if (!rows) throw Object.assign(new Error(`mock: unknown resource ${byKey[1]}`), { status: 404 })
    const row = rows.find(r => r.ObjectID === byKey[2])
    if (!row) throw Object.assign(new Error('mock: not found'), { status: 404 })
    // ETag validation: if the client sends If-Match, honour it (simulates C4C concurrency control)
    const ifMatch = headers?.['If-Match']
    if (ifMatch && ifMatch !== '*' && row.__metadata?.etag && ifMatch !== row.__metadata.etag) {
      throw Object.assign(new Error('mock: ETag mismatch'), { status: 412 })
    }
    Object.assign(row, data)
    if (row.__metadata) row.__metadata = { ...row.__metadata, etag: `W/"updated-${Date.now()}"` }
    return {}
  }

  if (method === 'POST') {
    if (resource === 'TasksCollection') {
      const objId = objectId()
      const task = { ObjectID: objId, ID: `T${created.tasks.length + 1}`, ...data }
      created.tasks.push(task)
      return { d: { ObjectID: objId, ID: task.ID } }
    }
    if (resource === 'TasksTextCollection') {
      created.taskTexts.push({ ...data })
      return {}
    }
    if (resource === 'TasksBTDReferenceCollection') {
      created.taskReferences.push({ ...data })
      return {}
    }
    if (resource === 'VisitAttachmentCollection') {
      // Store only metadata – skip the base64 Binary to keep tests lean
      created.attachments.push({ TypeCode: data?.TypeCode, Name: data?.Name, MimeType: data?.MimeType })
      return {}
    }
    throw Object.assign(new Error(`mock: POST to ${resource} not supported`), { status: 405 })
  }

  throw Object.assign(new Error(`mock: ${method} not supported`), { status: 405 })
}

/** Installs the mock transport; returns a function that restores the previous one. */
export function installC4CMock () {
  const previous = setTransport(mockTransport)
  return () => setTransport(previous)
}
