// Application-specific state only. C4C stays the system of record:
// no C4C master data is replicated here. Only the keys/IDs and the few display
// values needed for one documentation session are stored, and only while it runs.
//
// Field naming convention:
//   c4c*       = value read from or validated against C4C. Only CAP code sets these, never the AI.
//   proposed*  = value proposed by the AI from the conversation; not trusted until validated
namespace voice;

using {
  cuid,
  managed
} from '@sap/cds/common';

type C4CObjectID : String(70);
type C4CGuid     : String(36);

type SessionStatus : String(20) enum {
  ACTIVE;            // conversation running, no Visit selected yet
  VISIT_SELECTED;    // user confirmed exactly one Visit
  PREVIEW;           // commit preview read back, waiting for confirmation
  COMMITTING;        // confirmed, C4C writes running
  COMPLETED;         // all C4C operations succeeded
  PARTIAL_FAILURE;   // some C4C operations failed
  FAILED;            // commit failed before any C4C change
  CANCELLED;         // user stopped the session
  NO_VISIT;          // no matching open Visit today → aborted (no Visit creation)
}

type TranscriptRole : String(10) enum {
  user;
  assistant;
}

type ValidationStatus : String(10) enum {
  PENDING;
  VALID;
  AMBIGUOUS;
  INVALID;
}

type ActualEndSource : String(16) enum {
  USER_STATED;       // user named the end time
  PLANNED_FALLBACK;  // planned Visit EndDateTime was used
}

type ConfirmationStatus : String(12) enum {
  PENDING;
  CONFIRMED;
  SUPERSEDED;        // draft changed after the preview → preview no longer valid
}

type OperationKind : String(24) enum {
  ATTACH_SUMMARY_PDF;
  ATTACH_TRANSCRIPT_PDF;
  CREATE_TASK;
  CREATE_TASK_TEXT;
  CREATE_TASK_LINK;
  UPDATE_VISIT_END;
  UPDATE_VISIT_STATUS;
}

type OperationStatus : String(16) enum {
  PENDING;
  IN_PROGRESS;
  SUCCEEDED;
  SKIPPED_EXISTING;  // object already existed in C4C → not created again
  FAILED;
}

entity VoiceSessions : cuid, managed {
  userId                   : String(255) not null; // login user (from the identity provider)
  userEmail                : String(255);
  c4cEmployeeUUID          : C4CGuid; // Employee.UUID of the logged-in user (validated)
  c4cEmployeeBPID          : String(10); // Employee.BusinessPartnerID
  language                 : String(2); // last detected conversation language: de | en
  timeZone                 : String(64); // IANA time zone of the device, e.g. Europe/Berlin
  status                   : SessionStatus default 'ACTIVE';
  expiresAt                : Timestamp;
  visitCandidates          : LargeString; // JSON: candidates last returned to the AI (ObjectIDs only + display data)
  draft                    : Composition of one VisitDrafts
                               on draft.session = $self;
  transcript               : Composition of many TranscriptEntries
                               on transcript.session = $self;
  confirmations            : Composition of many CommitConfirmations
                               on confirmations.session = $self;
  operations               : Composition of many CommitOperations
                               on operations.session = $self;
}

entity TranscriptEntries : cuid {
  session  : Association to VoiceSessions not null;
  seq      : Integer not null;
  role     : TranscriptRole not null;
  text     : LargeString;
  itemId   : String(100); // realtime conversation item id
  at       : Timestamp @cds.on.insert: $now;
}

entity VisitDrafts : cuid, managed {
  session                  : Association to VoiceSessions not null;
  version                  : Integer default 1; // incremented on every change; part of the preview hash

  // --- validated C4C data (set by CAP only) ---------------------------------
  c4cVisitObjectID         : C4CObjectID;
  c4cVisitID               : String(35);
  c4cVisitETag             : String(100);
  c4cSubject               : String(765);
  c4cAccountUUID           : C4CGuid;
  c4cAccountName           : String(255);
  c4cPlannedStart          : Timestamp;
  c4cPlannedEnd            : Timestamp;

  // --- proposed by the AI -----------------------------------------------------
  proposedSummary          : LargeString;
  proposedActualEnd        : Timestamp;
  actualEndSource          : ActualEndSource;

  tasks                    : Composition of many TaskDrafts
                               on tasks.visitDraft = $self;
}

entity TaskDrafts : cuid, managed {
  visitDraft               : Association to VisitDrafts not null;
  position                 : Integer;

  // --- proposed by the AI -----------------------------------------------------
  proposedSubject          : String(765);
  proposedDescription      : LargeString;
  proposedDueDate          : Date;
  proposedProcessorName    : String(255); // as spoken, e.g. "Patrick"; empty → processor = user

  // --- validated against C4C (set by CAP only) --------------------------------
  processorStatus          : ValidationStatus default 'PENDING';
  processorMessage         : String(500);
  c4cProcessorUUID         : C4CGuid; // Employee.UUID → Tasks.ProcessorUUID
  c4cProcessorBPID         : String(10); // Employee.BusinessPartnerID
  c4cProcessorName         : String(480); // Employee.BusinessPartnerFormattedName (for read-back)
}

entity CommitConfirmations : cuid {
  session                  : Association to VoiceSessions not null;
  draftVersion             : Integer not null;
  previewHash              : String(64) not null; // SHA-256 over the frozen draft content
  previewText              : LargeString; // what was read back to the user
  status                   : ConfirmationStatus default 'PENDING';
  createdAt                : Timestamp @cds.on.insert: $now;
  confirmedAt              : Timestamp;
  confirmationUtterance    : String(500); // transcribed user utterance that confirmed
}

entity CommitOperations : cuid {
  session                  : Association to VoiceSessions not null;
  confirmation             : Association to CommitConfirmations;
  taskDraft                : Association to TaskDrafts;
  seq                      : Integer not null;
  kind                     : OperationKind not null;
  idempotencyKey           : String(200) not null;
  status                   : OperationStatus default 'PENDING';
  attempts                 : Integer default 0;
  c4cObjectID              : C4CObjectID; // ObjectID of the created / updated C4C object
  c4cID                    : String(35); // readable ID (e.g. Task ID)
  lastError                : String(1000);
  updatedAt                : Timestamp @cds.on.insert: $now  @cds.on.update: $now;
}

annotate CommitOperations with @assert.unique: {idempotencyKey: [idempotencyKey]};

// Metadata only – no conversation content (see docs/open-security-risks.md, P1).
entity AuditLog : cuid {
  at                       : Timestamp @cds.on.insert: $now;
  userId                   : String(255);
  sessionId                : UUID;
  event                    : String(50) not null;
  c4cVisitObjectID         : C4CObjectID;
  outcome                  : String(20);
  details                  : String(1000); // e.g. created Task IDs, error codes
}
