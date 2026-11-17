// C4C code values and EntitySets used by this app.
// Every value here was verified against the project's C4C tenant (see docs/c4c-metadata/).
// Do not add values that were not verified.

export const ENTITY_SETS = {
  visit: 'VisitCollection', // docs/c4c-metadata/Visit.xml
  visitAttachment: 'VisitAttachmentCollection', // VisitAttachment.xml
  employee: 'EmployeeCollection', // Employee.xml (confirmed by GET)
  task: 'TasksCollection', // Tasks.sample.json (confirmed by GET)
  taskBtdReference: 'TasksBTDReferenceCollection' // TasksBTDReference.xml (confirmed by GET)
}

export const VISIT_STATUS = { OPEN: '1', IN_PROCESS: '2', COMPLETED: '3', CANCELED: '4' } // VisitStatusCollection.json

export const VISIT_ATTACHMENT = {
  CATEGORY_DOCUMENT: '2', // VisitAttachmentCategoryCodeCollection
  TYPE_STANDARD: '10001', // → transcript PDF
  TYPE_SUMMARY: '10009' // → summary PDF
}

export const TASK = {
  DOCUMENT_TYPE_ACTIVITY_TASK: '0006', // Tasks.sample.json
  PRIORITY_NORMAL: '3', // Tasks.sample.json
  TIME_ZONE_UTC: 'UTC', // Tasks.sample.json
  TEXT_TYPE_BODY: '10002' // TasksTextCollectionTypeCodeCollection
}

export const TASK_BTD_REFERENCE = {
  TYPE_APPOINTMENT: '12', // used by C4C itself for a follow-up of a Visit (TasksBTDReference.xml)
  ROLE_PREDECESSOR: '1' // TasksBTDReferenceBTDRoleCodeCollection
}
