// Phase 6 – bridge structure tests (no AI Core or WebSocket needed).
// Tests that all tools and prompt are correctly defined before any E2E run.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SYSTEM_PROMPT, AI_TOOLS } from '../srv/lib/ai-tools.js'
import { createVoiceToken } from '../srv/voice-bridge.js'

// Expected tools (keep in sync with VoiceAssistantService actions)
const EXPECTED_TOOL_NAMES = [
  'findVisit', 'selectVisit', 'getVisitContext', 'resolveEmployee',
  'updateVisitDraft', 'addTaskDraft', 'updateTaskDraft', 'removeTaskDraft',
  'prepareCommitPreview', 'confirmCommit'
]

describe('Phase 6 – AI tool definitions', () => {
  it('has the right number of tools', () => {
    assert.equal(AI_TOOLS.length, EXPECTED_TOOL_NAMES.length)
  })

  it('every tool has type "function", a name, and a parameters object', () => {
    for (const t of AI_TOOLS) {
      assert.equal(t.type, 'function', `${t.name}: type must be "function"`)
      assert.ok(t.name, 'name must be non-empty')
      assert.ok(t.parameters && typeof t.parameters === 'object', `${t.name}: parameters must be an object`)
    }
  })

  it('covers all expected tool names', () => {
    const names = new Set(AI_TOOLS.map(t => t.name))
    for (const expected of EXPECTED_TOOL_NAMES) {
      assert.ok(names.has(expected), `missing tool: ${expected}`)
    }
  })

  it('no tool exposes sessionId to the AI', () => {
    for (const t of AI_TOOLS) {
      const props = Object.keys(t.parameters?.properties ?? {})
      assert.ok(!props.includes('sessionId'), `${t.name}: sessionId must not be in parameters (bridge injects it)`)
    }
  })
})

describe('Phase 6 – system prompt', () => {
  it('is a non-empty string with German and security rules', () => {
    assert.ok(typeof SYSTEM_PROMPT === 'string' && SYSTEM_PROMPT.length > 100)
    assert.ok(SYSTEM_PROMPT.includes('confirmCommit'), 'prompt must reference confirmCommit')
    assert.ok(SYSTEM_PROMPT.includes('NIEMALS'), 'prompt must contain the "no new visits" rule')
  })
})

describe('Phase 6 – voice token', () => {
  it('createVoiceToken returns a UUID-shaped string', () => {
    const fakeUser = { id: 'alice', attr: { email: 'alice@example.com' } }
    const token = createVoiceToken(fakeUser)
    assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('createVoiceToken returns unique tokens for each call', () => {
    const fakeUser = { id: 'alice', attr: { email: 'alice@example.com' } }
    const t1 = createVoiceToken(fakeUser)
    const t2 = createVoiceToken(fakeUser)
    assert.notEqual(t1, t2)
  })
})
