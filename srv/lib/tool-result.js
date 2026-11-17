// Uniform result object for all AI tools (see VoiceAssistantService.ToolResult).
// `data` is serialised to JSON because it is passed to the AI as function call output.

export const toolResult = (ok, code, message, data = null) => ({
  ok,
  code,
  message,
  data: data === null || data === undefined ? null : JSON.stringify(data)
})

export const ok = (code, message, data) => toolResult(true, code, message, data)
export const fail = (code, message, data) => toolResult(false, code, message, data)
