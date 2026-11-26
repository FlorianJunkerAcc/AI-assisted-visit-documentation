// WebSocket bridge: browser ⇄ CAP ⇄ AI Core (gpt-realtime).
//
// Browser protocol:
//   Text frames   → JSON control messages  { type, ...payload }
//   Binary frames → raw PCM16 mono 24 kHz from the microphone
//
// CAP → Browser:
//   Text frames   → JSON events  { type: 'ready'|'transcript'|'commit_preview'|'done'|'error'|'stopped', ... }
//   Binary frames → raw PCM16 mono 24 kHz (AI speech)
//
// Authentication: before opening the WebSocket, the browser calls GET /api/voice-token
// (authenticated HTTP request → one-time UUID). The WebSocket URL is /ws/voice?token=<uuid>.

import { WebSocketServer } from 'ws'
import cds from '@sap/cds'
import { SapOpenAiRealtimeWs } from '@sap-ai-sdk/openai/realtime'
import { SYSTEM_PROMPT, AI_TOOLS } from './lib/ai-tools.js'

const LOG = cds.log('voice-bridge')

// --- one-time token store (in-memory, server-process-scoped) ---
const tokens = new Map() // token → { userId, userEmail, expiresAt }
const TOKEN_TTL_MS = 60_000

export function createVoiceToken (user) {
  const token = cds.utils.uuid()
  // Prune expired tokens while we're here
  for (const [t, v] of tokens) if (v.expiresAt < Date.now()) tokens.delete(t)
  tokens.set(token, { userId: user.id, userEmail: user.attr?.email, expiresAt: Date.now() + TOKEN_TTL_MS })
  return token
}

function redeemToken (token) {
  const entry = tokens.get(token)
  if (!entry) return null
  tokens.delete(token) // one-time use
  return entry.expiresAt >= Date.now() ? entry : null
}

// --- WebSocket server registration (called from srv/server.js) ---
export function registerVoiceBridge (httpServer) {
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', (req, socket, head) => {
    let url
    try { url = new URL(req.url, 'http://localhost') } catch { socket.destroy(); return }
    if (!url.pathname.startsWith('/ws/voice')) { socket.destroy(); return }

    const userInfo = redeemToken(url.searchParams.get('token') ?? '')
    if (!userInfo) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => handleVoiceConnection(ws, userInfo))
  })

  LOG.info('voice WebSocket bridge attached at /ws/voice')
}

// --- per-connection handler ---
async function handleVoiceConnection (ws, userInfo) {
  LOG.info('connection opened', { userId: userInfo.userId })

  const send = (obj) => { if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(obj)) }
  const sendBin = (buf) => { if (ws.readyState === 1) ws.send(buf, { binary: true }) }

  let sessionId = null
  let aiClient = null
  let audioReady = false // true once the AI Core socket is open AND the audio session is configured
  let transcriptSeq = 0

  // AI Core allows only one active response per conversation. A tool result often arrives while
  // the response that requested the tool is still running, so response.create has to wait.
  let responseActive = false
  let responsePending = false
  let openToolCalls = 0

  const flushResponse = () => {
    if (!aiClient || !responsePending || responseActive || openToolCalls > 0) return
    responsePending = false
    responseActive = true
    aiClient.send({ type: 'response.create' })
  }
  const requestResponse = () => { responsePending = true; flushResponse() }

  const getUser = () => new cds.User({ id: userInfo.userId, roles: ['VisitDocumenter'], attr: { email: userInfo.userEmail } })

  /** Calls a VoiceAssistantService action, injecting sessionId automatically. */
  const callTool = async (name, args = {}) => {
    const srv = await cds.connect.to('VoiceAssistantService')
    const data = sessionId ? { sessionId, ...args } : args
    try {
      return await srv.tx({ user: getUser() }, (tx) => tx.send(name, data))
    } catch (err) {
      LOG.error(`tool ${name} failed`, { message: err.message })
      return { ok: false, code: 'INTERNAL_ERROR', message: String(err.message), data: null }
    }
  }

  /** Stores one transcript entry in the DB and forwards it to the browser. */
  const addTranscript = async (role, text) => {
    const trimmed = String(text ?? '').trim()
    if (!trimmed || !sessionId) return
    send({ type: 'transcript', role, text: trimmed })
    try {
      const { TranscriptEntries } = cds.entities('voice')
      const { INSERT } = cds.ql
      await INSERT.into(TranscriptEntries).entries({
        ID: cds.utils.uuid(),
        session_ID: sessionId,
        seq: ++transcriptSeq,
        role,
        text: trimmed
      })
    } catch (err) {
      LOG.warn('transcript insert failed', { message: err.message })
    }
  }

  // While the user pauses, no audio flows. Ping the browser so proxies don't drop the idle socket.
  const keepAlive = setInterval(() => { if (ws.readyState === 1) ws.ping() }, 25_000)

  // --- browser message handler ---
  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      // Raw PCM16 from the microphone → forward to AI Core.
      // The browser streams right away; audio arriving before the session is ready is dropped
      // (sending on a still CONNECTING socket raises OpenAIRealtimeError "could not send data").
      if (aiClient && audioReady) aiClient.send({ type: 'input_audio_buffer.append', audio: data.toString('base64') })
      return
    }
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }

    if (msg.type === 'start') await handleStart(msg)
    else if (msg.type === 'stop') await handleStop()
  })

  ws.on('close', async () => {
    clearInterval(keepAlive)
    LOG.info('connection closed', { userId: userInfo.userId, sessionId })
    if (aiClient) { try { aiClient.close() } catch {} aiClient = null }
    if (sessionId) { try { await callTool('cancelSession') } catch {} sessionId = null }
  })

  ws.on('error', (err) => LOG.warn('ws error', { userId: userInfo.userId, message: err.message }))

  // --- start: open CAP session + connect to AI Core ---
  async function handleStart ({ timeZone, language }) {
    if (sessionId) { send({ type: 'error', code: 'ALREADY_STARTED', message: 'Session already running.' }); return }

    const startRes = await callTool('startSession', { timeZone: timeZone ?? 'UTC', language: language ?? 'de' })
    if (!startRes.ok) { send({ type: 'error', code: startRes.code, message: startRes.message }); return }
    sessionId = JSON.parse(startRes.data ?? '{}').sessionId

    const model = cds.env.voice?.aicore?.realtimeModel ?? 'gpt-realtime'
    try {
      aiClient = await SapOpenAiRealtimeWs.createClient(model)
    } catch (err) {
      LOG.error('AI Core connect failed', { message: err.message })
      // In development (mocked auth) with no AI Core binding: stay connected in silent mode
      // so the UI flow can be tested. Audio is accepted but no voice response comes back.
      if (cds.env.requires?.auth?.kind === 'mocked') {
        LOG.warn('AI Core unavailable in dev mode – session open without voice AI', { sessionId })
        send({ type: 'ready', sessionId })
        return
      }
      send({ type: 'error', code: 'AICORE_UNAVAILABLE', message: 'Could not connect to AI Core.' })
      try { await callTool('cancelSession') } catch {}
      sessionId = null
      return
    }

    audioReady = false
    responseActive = false
    responsePending = false
    openToolCalls = 0
    attachAiHandlers(aiClient)

    // Tell the user if AI Core ends the connection (e.g. session time limit during a long pause).
    // On a deliberate close aiClient is already null when this event fires.
    const client = aiClient
    client.socket?.on('close', () => {
      if (aiClient !== client) return
      audioReady = false
      send({ type: 'error', code: 'AICORE_CLOSED', message: 'Die Verbindung zum Sprachdienst wurde beendet. Bitte starte ein neues Gespräch.' })
    })

    // Wait for session.created: AI Core confirms the initial session setup.
    // createClient resolves while the WebSocket may still be CONNECTING, so nothing must be
    // sent before this event (same pattern as the spike).
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('session.created timeout')), 20_000)
        let done = false
        aiClient.on('session.created', () => {
          if (!done) { done = true; clearTimeout(timer); resolve() }
        })
      })
    } catch (err) {
      LOG.error('AI Core session.created timeout', { message: err.message, sessionId })
      send({ type: 'error', code: 'AICORE_TIMEOUT', message: 'AI Core did not respond in time.' })
      try { await callTool('cancelSession') } catch {}
      sessionId = null
      if (aiClient) { try { aiClient.close() } catch {} aiClient = null }
      return
    }

    const transcriptionModel = cds.env.voice?.aicore?.transcriptionModel ?? 'whisper-1'

    // Two-step session init mirrors the proven spike pattern:
    //   Update 1 – text mode + instructions + tools  (spike step 2: confirmed instructions work)
    //   Update 2 – audio mode + voice + VAD          (spike steps 3-5: confirmed audio works)
    //   Instructions from update 1 persist because session.update merges, not replaces.
    //   After both confirmations send response.create so the AI greets proactively (SYSTEM_PROMPT step 1).
    let initStep = 0
    aiClient.on('session.updated', (e) => {
      initStep++
      LOG.debug('session.updated', { step: initStep, hasInstructions: !!e?.session?.instructions })
      if (initStep === 1) {
        aiClient.send({
          type: 'session.update',
          session: {
            type: 'realtime',
            output_modalities: ['audio'],
            audio: {
              output: { voice: 'alloy' },
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                transcription: { model: transcriptionModel },
                turn_detection: { type: 'server_vad', create_response: true }
              }
            }
          }
        })
      } else if (initStep === 2) {
        audioReady = true
        requestResponse() // greeting
      }
    })

    // Update 1: instructions + tools in text mode (proven by spike)
    aiClient.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['text'],
        instructions: SYSTEM_PROMPT,
        tools: AI_TOOLS,
        tool_choice: 'auto'
      }
    })

    send({ type: 'ready', sessionId })
    LOG.info('session ready', { sessionId, userId: userInfo.userId })
  }

  async function handleStop () {
    if (!sessionId) return
    try { await callTool('cancelSession') } catch {}
    sessionId = null
    if (aiClient) { try { aiClient.close() } catch {} aiClient = null }
    send({ type: 'stopped' })
  }

  // --- AI Core event handlers ---
  function attachAiHandlers (client) {
    // Audio out → browser (binary PCM16)
    client.on('response.output_audio.delta', (e) => {
      if (e.delta) sendBin(Buffer.from(e.delta, 'base64'))
    })

    // Voice activity (server VAD) drives the status display in the browser
    client.on('input_audio_buffer.speech_started', () => send({ type: 'speech', active: true }))
    client.on('input_audio_buffer.speech_stopped', () => send({ type: 'speech', active: false }))

    // Transcript: user utterance (whisper-1 or VAD-committed audio)
    client.on('conversation.item.input_audio_transcription.completed', (e) => {
      addTranscript('user', e.transcript)
    })

    // Transcript: assistant speech (output audio transcript)
    client.on('response.output_audio_transcript.done', (e) => {
      addTranscript('assistant', e.transcript)
    })

    // Tool calls – dispatch to VoiceAssistantService, return result to AI Core
    client.on('response.function_call_arguments.done', async (e) => {
      const { call_id, name, arguments: argsStr } = e
      let args
      try { args = JSON.parse(argsStr ?? '{}') } catch { args = {} }
      LOG.debug('tool call', { name, args })

      openToolCalls++
      let result
      try {
        result = await callTool(name, args)

        // Send the tool output back to AI Core so it can continue
        client.send({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id, output: JSON.stringify(result) }
        })
      } finally {
        openToolCalls--
      }
      requestResponse() // sent now, or after the running response is done

      // Forward notable results to the browser UI
      if (name === 'prepareCommitPreview' && result.ok) {
        const d = JSON.parse(result.data ?? '{}')
        send({ type: 'commit_preview', previewHash: d.previewHash, previewText: d.previewText })
      } else if (name === 'confirmCommit') {
        let errors = []
        try { errors = JSON.parse(result.data ?? '{}')?.errors ?? [] } catch {}
        const failed = errors.map(e => `${e.what}: ${String(e.lastError).replace(/^C4C \w+ failed( \(\d+\))?:?\s*/, '')}`)
        send({ type: 'done', status: result.code === 'COMMIT_COMPLETED' ? 'COMPLETED' : 'PARTIAL_FAILURE', code: result.code, failed })
      }
    })

    // Also covers responses started by server VAD, not only our own response.create
    client.on('response.created', () => { responseActive = true })
    client.on('response.done', () => { responseActive = false; flushResponse() })

    client.on('error', (e) => {
      // Remaining race (server VAD started a response at the same moment): harmless, retry later
      const code = e?.error?.code
      if (code === 'conversation_already_has_active_response' ||
          /active response in progress/i.test(e?.error?.message ?? e?.message ?? '')) {
        LOG.warn('response.create while a response was active – retrying after response.done')
        responseActive = true
        responsePending = true
        return
      }
      LOG.error('AI Core error', e)
      // readable text for the UI instead of '{"name":"OpenAIRealtimeError","cause":{}}'
      const text = e?.error?.message ?? e?.message ?? 'Unbekannter Fehler'
      send({ type: 'error', code: 'AICORE_ERROR', message: `Fehler im Sprachdienst: ${text}`.slice(0, 500) })
    })
  }
}
