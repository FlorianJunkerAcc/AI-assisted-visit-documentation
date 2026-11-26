// The ONLY module that knows C4C EntitySets, properties and query syntax.
// All C4C access goes through the CAP remote service "c4c" (BTP Destination SAP_Sales_Cloud_V1).
// The AI never reaches this module directly – only VoiceAssistantService does.
import cds from '@sap/cds'
import { ENTITY_SETS, VISIT_STATUS, TASK, TASK_BTD_REFERENCE, VISIT_ATTACHMENT } from './c4c-codes.js'
import { parseODataDate } from './time.js'

const LOG = cds.log('c4c')

// --- transport (replaceable in tests) -------------------------------------------------------

let transport = async ({ method, path, data, headers }) => {
  const srv = await cds.connect.to('c4c')
  return srv.send({ method, path, data, headers })
}

/** Test seam: replace the HTTP transport (e.g. by test/mocks/c4c-mock.js). Returns the previous one. */
export function setTransport (fn) {
  const previous = transport
  transport = fn
  return previous
}

export class C4CError extends Error {
  constructor (message, { status, cause } = {}) {
    super(message)
    this.name = 'C4CError'
    this.status = status
    this.cause = cause
  }
}

async function request (method, path, data, headers) {
  try {
    return await transport({ method, path, data, headers })
  } catch (err) {
    const status = err.status ?? err.statusCode ?? err.response?.status ?? err.reason?.response?.status
    LOG.error(`${method} ${path.split('?')[0]} failed`, { status, message: err.message })
    // Keep C4C's own business message (e.g. "mandatory tasks or surveys incomplete") so it reaches
    // CommitOperations.lastError and the AI instead of a bare "C4C PATCH failed".
    const detail = String(err.message ?? '').replace(/^Error during request to remote service:\s*/i, '').slice(0, 300)
    throw new C4CError(`C4C ${method} failed${status ? ` (${status})` : ''}${detail ? `: ${detail}` : ''}`, { status, cause: err })
  }
}

// --- OData helpers ----------------------------------------------------------------------------

/** OData string literal with escaped single quotes. */
export const str = (v) => `'${String(v).replace(/'/g, "''")}'`

/** Builds "EntitySet?$filter=...&$select=..." with URL-encoded parameter values. */
export function buildPath (entitySet, params = {}) {
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')
  return `/${entitySet}${query ? '?' + query : ''}`
}

/** Normalises OData V2 collection responses (raw `d.results` or already unwrapped arrays). */
export function rowsOf (res) {
  if (Array.isArray(res)) return res
  if (Array.isArray(res?.d?.results)) return res.d.results
  if (Array.isArray(res?.results)) return res.results
  if (Array.isArray(res?.value)) return res.value
  if (res?.d) return [res.d]
  return res ? [res] : []
}

const etagOf = (row) => row?.__metadata?.etag ?? null

// --- Visit ------------------------------------------------------------------------------------

const VISIT_SELECT = [
  'ObjectID', 'ID', 'Subject', 'Status', 'StartDateTime', 'EndDateTime', 'Account', 'AccountName',
  'AccountPartyName', 'MainAccountPartyID', 'PrimaryContactPartyName', 'Location',
  'OwnerEmailURI', 'OrganizerEmailURI', 'MarkedForDeletion'
].join(',')

function mapVisit (row) {
  return {
    objectID: row.ObjectID,
    id: row.ID,
    subject: row.Subject || null,
    status: row.Status,
    start: parseODataDate(row.StartDateTime),
    end: parseODataDate(row.EndDateTime),
    accountUUID: row.Account || null,
    accountName: row.AccountName || row.AccountPartyName || null,
    mainAccountPartyID: row.MainAccountPartyID || null,
    primaryContactName: row.PrimaryContactPartyName || null,
    location: row.Location || null,
    ownerEmail: row.OwnerEmailURI || null,
    organizerEmail: row.OrganizerEmailURI || null,
    markedForDeletion: row.MarkedForDeletion === true,
    etag: etagOf(row)
  }
}

const sameEmail = (a, b) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

/** True if `email` is Owner or Organizer of the Visit. */
export const isOwnerOrOrganizer = (visit, email) =>
  sameEmail(visit.ownerEmail, email) || sameEmail(visit.organizerEmail, email)

/**
 * Open Visits where `email` is Owner OR Organizer, filtered client-side to [start, end).
 * C4C rejects "or" across different properties, so two queries are merged.
 * Note: StartDateTime (Edm.DateTimeOffset) range filter is applied client-side because
 * C4C's ABAP OData layer rejects datetimeoffset/datetime literals in ge/lt comparisons.
 */
export async function findOpenVisitsForUser (email, { start, end }) {
  const queries = ['OwnerEmailURI', 'OrganizerEmailURI'].map(prop => buildPath(ENTITY_SETS.visit, {
    $filter: `${prop} eq ${str(email)} and Status eq ${str(VISIT_STATUS.OPEN)}`,
    $select: VISIT_SELECT,
    $top: 50,
    $format: 'json'
  }))
  const results = await Promise.all(queries.map(p => request('GET', p)))
  const byId = new Map()
  for (const row of results.flatMap(rowsOf)) {
    const v = mapVisit(row)
    if (!v.markedForDeletion && v.status === VISIT_STATUS.OPEN &&
        v.start && v.start >= start && v.start < end) {
      byId.set(v.objectID, v)
    }
  }
  return [...byId.values()].sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
}

/** Reads one Visit by ObjectID (fresh from C4C). Returns null if not found. */
export async function getVisit (objectID) {
  if (!/^[0-9A-Fa-f]{32}$/.test(objectID ?? '')) return null
  try {
    const res = await request('GET', `/${ENTITY_SETS.visit}(${str(objectID)})?$select=${VISIT_SELECT}&$format=json`)
    const row = rowsOf(res)[0]
    return row ? mapVisit(row) : null
  } catch (err) {
    if (err.status === 404) return null
    throw err
  }
}

// --- Employee ---------------------------------------------------------------------------------

const EMPLOYEE_SELECT = [
  'ObjectID', 'UUID', 'EmployeeID', 'BusinessPartnerID', 'BusinessPartnerFormattedName',
  'FirstName', 'LastName', 'Email', 'EmployeeValidityStartDate', 'EmployeeValidityEndDate',
  'UserValidityStartDate', 'UserValidityEndDate', 'UserLockedIndicator'
].join(',')

function mapEmployee (row) {
  return {
    objectID: row.ObjectID,
    uuid: row.UUID,
    businessPartnerID: row.BusinessPartnerID,
    name: row.BusinessPartnerFormattedName || [row.FirstName, row.LastName].filter(Boolean).join(' '),
    firstName: row.FirstName,
    lastName: row.LastName,
    email: row.Email || null,
    employeeValidFrom: parseODataDate(row.EmployeeValidityStartDate),
    employeeValidTo: parseODataDate(row.EmployeeValidityEndDate),
    userValidFrom: parseODataDate(row.UserValidityStartDate),
    userValidTo: parseODataDate(row.UserValidityEndDate),
    locked: row.UserLockedIndicator === true
  }
}

const within = (now, from, to) => (!from || from <= now) && (!to || now <= to)

/**
 * Active = employee validity AND user validity include today and the user is not locked.
 * (Decision 2026-11-16: employees without a valid user cannot get Tasks.)
 */
export function isActiveEmployee (e, now = new Date()) {
  if (e.locked) return false
  if (!e.userValidFrom && !e.userValidTo) return false // no business user
  return within(now, e.employeeValidFrom, e.employeeValidTo) && within(now, e.userValidFrom, e.userValidTo)
}

async function queryEmployees (filter) {
  const res = await request('GET', buildPath(ENTITY_SETS.employee, { $filter: filter, $select: EMPLOYEE_SELECT, $top: 20, $format: 'json' }))
  return rowsOf(res).map(mapEmployee)
}

/** Active employees with exactly this e-mail. */
export async function findActiveEmployeesByEmail (email) {
  return (await queryEmployees(`Email eq ${str(email)}`)).filter(e => isActiveEmployee(e))
}

/**
 * Active employees matching a spoken name.
 * "Patrick" → FirstName eq OR LastName eq (two queries); "Patrick Müller" → FirstName and LastName.
 */
export async function findActiveEmployeesByName (name) {
  const tokens = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return []
  let found
  if (tokens.length === 1) {
    const [byFirst, byLast] = await Promise.all([
      queryEmployees(`FirstName eq ${str(tokens[0])}`),
      queryEmployees(`LastName eq ${str(tokens[0])}`)
    ])
    found = [...byFirst, ...byLast]
  } else {
    found = await queryEmployees(`FirstName eq ${str(tokens[0])} and LastName eq ${str(tokens.slice(1).join(' '))}`)
  }
  const byUuid = new Map(found.filter(e => isActiveEmployee(e)).map(e => [e.uuid, e]))
  return [...byUuid.values()]
}

// --- write operations (phase 5) ----------------------------------------------------------------

const toODataDate = (d) => d ? `/Date(${new Date(d).getTime()})/` : null

/**
 * PATCHes a Visit. `actualEnd` is an ISO timestamp; `status` is a VISIT_STATUS code.
 * The ETag captured when the Visit was selected is stale after a few minutes of conversation
 * (and changes after every PATCH), so the current ETag is read right before writing.
 * On 412 the Visit is re-read once and the PATCH retried with the new ETag.
 * The `etag` argument is only a fallback if the fresh read fails.
 */
export async function patchVisit (objectID, etag, { actualEnd, status } = {}) {
  const body = {}
  if (actualEnd !== undefined) body.ActualEndDateTime = toODataDate(actualEnd)
  if (status !== undefined) body.Status = status
  if (!Object.keys(body).length) return
  const path = `/${ENTITY_SETS.visit}('${objectID}')`
  const send = (tag) => request('PATCH', path, body, tag ? { 'If-Match': tag } : undefined)

  const freshEtag = async () => (await getVisit(objectID))?.etag ?? null
  let tag = await freshEtag().catch(() => null) ?? etag
  try {
    await send(tag)
  } catch (err) {
    if (err.status !== 412) throw err
    LOG.warn(`PATCH ${path} got 412, retrying once with a fresh ETag`)
    tag = await freshEtag()
    if (!tag) throw err
    await send(tag)
  }
}

/** Creates a Task in C4C and returns { objectID, id }. */
export async function createTask ({ subject, dueDateISO, accountUUID, ownerUUID, processorUUID, processorPartyID }) {
  const body = {
    Subject: subject,
    DocumentType: TASK.DOCUMENT_TYPE_ACTIVITY_TASK,
    PriorityCode: TASK.PRIORITY_NORMAL,
    AccountUUID: accountUUID,
    OwnerUUID: ownerUUID,
    ProcessorUUID: processorUUID,
    // C4C rejects a Task with only a due date ("end date and time must be later than start date and
    // time": it derives its own Start). So send an explicit 1h window on the due day (09:00–10:00 UTC),
    // which keeps the calendar date correct in all time zones from UTC-9 to UTC+13.
    ...(dueDateISO ? {
      StartDateTime: toODataDate(new Date(dueDateISO + 'T09:00:00Z')),
      StartDatetimeZoneCode: TASK.TIME_ZONE_UTC,
      DueDateTime: toODataDate(new Date(dueDateISO + 'T10:00:00Z')),
      DueDatetimeZoneCode: TASK.TIME_ZONE_UTC
    } : {}),
    ...(processorPartyID ? { ProcessorPartyID: processorPartyID } : {})
  }
  const res = await request('POST', `/${ENTITY_SETS.task}`, body)
  const row = (rowsOf(res)[0] ?? res?.d ?? res) ?? {}
  return { objectID: row.ObjectID, id: row.ID }
}

/** Creates a task description (body text). */
export async function createTaskDescription (taskObjectID, text) {
  const body = { TypeCode: TASK.TEXT_TYPE_BODY, Text: text }
  try {
    await request('POST', `/${ENTITY_SETS.taskText}`, { ParentObjectID: taskObjectID, ...body })
  } catch (err) {
    // The test tenant rejected the flat set ("service is not assigned to you", 2026-11-26) although
    // the Task itself was created. Retry through the navigation property of the Task (Tasks.xml).
    LOG.warn('TasksTextCollection POST failed, retrying via Task navigation property', { status: err.status })
    await request('POST', `/${ENTITY_SETS.task}('${taskObjectID}')/TasksTextCollection`, body)
  }
}

/** Creates the BTD reference linking the task back to the Visit (using Visit.ID, not ObjectID). */
export async function createTaskVisitLink (taskObjectID, visitID) {
  await request('POST', `/${ENTITY_SETS.taskBtdReference}`, {
    ParentObjectID: taskObjectID,
    ID: visitID,
    TypeCode: TASK_BTD_REFERENCE.TYPE_APPOINTMENT,
    BTDRoleCode: TASK_BTD_REFERENCE.ROLE_PREDECESSOR
  })
}

/** Attaches a PDF to a Visit. `pdfBytes` is a Uint8Array or Buffer. */
export async function createVisitAttachment ({ visitObjectID, typeCode, name, pdfBytes }) {
  const body = {
    CategoryCode: VISIT_ATTACHMENT.CATEGORY_DOCUMENT,
    TypeCode: typeCode,
    Name: name,
    MimeType: 'application/pdf',
    Binary: Buffer.from(pdfBytes).toString('base64')
  }
  // POST to the flat VisitAttachmentCollection returned 404 on the test tenant (2026-11-25), so the
  // navigation property "VisitAttachment" of the Visit (Visit.xml) is used first, the flat set as fallback.
  try {
    await request('POST', `/${ENTITY_SETS.visit}('${visitObjectID}')/VisitAttachment`, body)
  } catch (err) {
    if (err.status !== 404) throw err
    LOG.warn('Visit/VisitAttachment navigation POST returned 404, trying flat VisitAttachmentCollection')
    await request('POST', `/${ENTITY_SETS.visitAttachment}`, { ParentObjectID: visitObjectID, ...body })
  }
}
