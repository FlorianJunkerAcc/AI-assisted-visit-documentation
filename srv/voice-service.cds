// Controlled tool surface for the realtime AI.
//
// @protocol: 'none' → this service is NOT exposed over HTTP. Browsers cannot call it.
// Only the server-side voice bridge (srv/voice/, phase 6) calls it in-process, on behalf of
// the authenticated user. Every action checks that the session belongs to that user.
//
// There is deliberately no generic "execute OData request" function. Each tool takes
// structured intent; CAP validates it and maps it to C4C (srv/lib/, phases 2-5).
//
// All tools return ToolResult. The voice bridge passes `data` (JSON) to the AI as the
// function call output.
@protocol: 'none'
@requires: 'VisitDocumenter'
service VoiceAssistantService {

  type ToolResult {
    ok      : Boolean;
    code    : String(40); // machine-readable outcome, e.g. VISIT_FOUND, AMBIGUOUS, NO_VISIT
    message : String(1000); // short hint for the AI (not shown to the user verbatim)
    data    : LargeString; // JSON payload for the AI
  }

  // --- session -------------------------------------------------------------------------------
  action startSession(timeZone : String(64), language : String(2))              returns ToolResult;
  action cancelSession(sessionId : UUID)                                         returns ToolResult;

  // --- Visit identification and context (phase 2) --------------------------------------------
  action findVisit(sessionId : UUID)                                             returns ToolResult;
  action selectVisit(sessionId : UUID, visitObjectID : String(70))               returns ToolResult;
  action getVisitContext(sessionId : UUID)                                       returns ToolResult;
  action resolveEmployee(sessionId : UUID, name : String(255))                   returns ToolResult;

  // --- draft (phase 3/4) ---------------------------------------------------------------------
  action updateVisitDraft(sessionId : UUID,
                          summary : LargeString,
                          actualEndTime : String(5), // local time HH:mm as stated by the user
                          usePlannedEnd : Boolean)                               returns ToolResult;
  action addTaskDraft(sessionId : UUID,
                      subject : String(765),
                      description : LargeString,
                      dueDate : Date,
                      dueTime : String(5),
                      processorName : String(255))                               returns ToolResult;
  action updateTaskDraft(sessionId : UUID,
                         taskId : UUID,
                         subject : String(765),
                         description : LargeString,
                         dueDate : Date,
                         dueTime : String(5),
                         processorName : String(255))                            returns ToolResult;
  action removeTaskDraft(sessionId : UUID, taskId : UUID)                        returns ToolResult;

  // --- confirmation and commit (phase 3-5) ---------------------------------------------------
  action prepareCommitPreview(sessionId : UUID)                                  returns ToolResult;
  action confirmCommit(sessionId : UUID,
                       previewHash : String(64),
                       userUtterance : String(500))                              returns ToolResult;
}
