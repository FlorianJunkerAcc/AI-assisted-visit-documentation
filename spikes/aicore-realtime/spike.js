// Spike: verify that GPT Realtime is usable through SAP AI Core from Node.js.
//
// What is checked (each step reports PASS / FAIL):
//   1. connect      – WebSocket session via @sap-ai-sdk/openai/realtime (deployment resolved by model name)
//   2. tool-call    – model calls a function tool, receives the result, answers in text
//   3. audio-out    – model answers with audio (PCM16 24 kHz); latency to first audio chunk; WAV written to ./out
//   4. transcribe   – (optional) generated audio is fed back as user input; built-in input transcription,
//                     one attempt per model in TRANSCRIBE_MODELS
//   4b. oob-transcribe – (optional) gpt-realtime itself transcribes the audio in an out-of-band response
//   5. server-vad   – (optional) server-side voice activity detection fires speech_started / speech_stopped
//
// Credentials: environment variable AICORE_SERVICE_KEY (the JSON of an SAP AI Core service key).
// Never commit the key. See README.md.

import { SapOpenAiRealtimeWs } from '@sap-ai-sdk/openai/realtime'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODEL = process.env.REALTIME_MODEL || 'gpt-realtime'
const TRANSCRIBE_MODELS = (process.env.TRANSCRIBE_MODELS || 'gpt-4o-mini-transcribe,gpt-4o-transcribe,whisper-1')
  .split(',').map(s => s.trim()).filter(Boolean)
const STEP_TIMEOUT_MS = Number(process.env.STEP_TIMEOUT_MS || 30000)
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out')
const SAMPLE_RATE = 24000

const EVENT_TYPES = [
  'session.created', 'session.updated', 'error',
  'response.created', 'response.done',
  'response.output_text.delta', 'response.output_text.done',
  'response.output_audio.delta', 'response.output_audio.done',
  'response.output_audio_transcript.delta', 'response.output_audio_transcript.done',
  'response.function_call_arguments.done',
  'input_audio_buffer.committed', 'input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped',
  'conversation.item.input_audio_transcription.completed',
  'conversation.item.input_audio_transcription.failed'
]

const results = []
const record = (step, ok, details, optional = false) => {
  results.push({ step, result: ok ? 'PASS' : (optional ? 'FAIL (optional)' : 'FAIL'), details })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${step}: ${details}`)
}

// ---------------------------------------------------------------------------------------------
// Event bus: buffers every event so that nothing is lost between send() and waitFor().
// ---------------------------------------------------------------------------------------------
function attachBus (client) {
  const seen = [] // { type, e, consumed }
  const waiters = [] // { match, resolve, reject, label }
  const listeners = new Map() // type -> [fn]

  const dispatch = (type, e) => {
    const entry = { type, e, consumed: false }
    seen.push(entry)
    for (const fn of listeners.get(type) || []) fn(e)
    if (type === 'error') {
      const msg = JSON.stringify(e?.error ?? e)
      console.error(`  ! error event: ${msg}`)
      for (const w of waiters.splice(0)) w.reject(new Error(`error event while waiting for ${w.label}: ${msg}`))
      return
    }
    for (const w of [...waiters]) {
      if (w.match(type, e)) {
        entry.consumed = true
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(e)
        break
      }
    }
  }
  for (const type of EVENT_TYPES) client.on(type, (e) => dispatch(type, e))

  return {
    on: (type, fn) => listeners.set(type, [...(listeners.get(type) || []), fn]),
    off: (type) => listeners.delete(type),
    waitFor (label, match) {
      const hit = seen.find(s => !s.consumed && match(s.type, s.e))
      if (hit) { hit.consumed = true; return Promise.resolve(hit.e) }
      return new Promise((resolve, reject) => {
        const w = { match, resolve, reject, label }
        waiters.push(w)
        setTimeout(() => {
          const i = waiters.indexOf(w)
          if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timeout after ${STEP_TIMEOUT_MS} ms waiting for ${label}`)) }
        }, STEP_TIMEOUT_MS)
      })
    }
  }
}

const isType = (t) => (type) => type === t

function wavFromPcm16 (pcm, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function appendAudio (client, pcm) {
  const chunk = SAMPLE_RATE * 2 / 10 // 100 ms of PCM16 mono
  for (let i = 0; i < pcm.length; i += chunk) {
    client.send({ type: 'input_audio_buffer.append', audio: pcm.subarray(i, i + chunk).toString('base64') })
  }
}

async function updateSession (client, bus, session) {
  client.send({ type: 'session.update', session: { type: 'realtime', ...session } })
  await bus.waitFor('session.updated', isType('session.updated'))
}

// ---------------------------------------------------------------------------------------------
async function main () {
  if (!process.env.AICORE_SERVICE_KEY) {
    console.warn('WARN: AICORE_SERVICE_KEY is not set. This only works if an AI Core service binding is available (VCAP_SERVICES).')
  }
  console.log(`Model: ${MODEL} | step timeout: ${STEP_TIMEOUT_MS} ms\n`)

  // 1. connect -------------------------------------------------------------------------------
  let client, bus
  try {
    const t0 = Date.now()
    client = await SapOpenAiRealtimeWs.createClient(MODEL)
    bus = attachBus(client)
    const created = await bus.waitFor('session.created', isType('session.created'))
    record('connect', true, `session.created after ${Date.now() - t0} ms (session model: ${created?.session?.model ?? 'n/a'})`)
  } catch (err) {
    record('connect', false, err.message)
    return finish(client)
  }

  // 2. tool-call ------------------------------------------------------------------------------
  try {
    await updateSession(client, bus, {
      output_modalities: ['text'],
      instructions: 'Du bist ein Testassistent. Wenn der Nutzer dich bittet, das Tool ping aufzurufen, rufe es auf. Antworte danach in einem kurzen Satz auf Deutsch.',
      tools: [{
        type: 'function',
        name: 'ping',
        description: 'Testfunktion. Gibt den übergebenen Wert zurück.',
        parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false }
      }],
      tool_choice: 'auto'
    })
    client.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Bitte rufe das Tool ping mit dem Wert 42 auf.' }] } })
    client.send({ type: 'response.create' })

    const call = await bus.waitFor('function call', isType('response.function_call_arguments.done'))
    await bus.waitFor('response.done (tool call)', isType('response.done'))
    const args = JSON.parse(call.arguments || '{}')
    if (call.name !== 'ping' || args.value !== 42) throw new Error(`unexpected call: ${call.name}(${call.arguments})`)

    let text = ''
    bus.on('response.output_text.delta', (e) => { text += e.delta ?? '' })
    client.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify({ echo: 42 }) } })
    client.send({ type: 'response.create' })
    await bus.waitFor('response.done (after tool output)', isType('response.done'))
    bus.off('response.output_text.delta')
    if (!text.trim()) throw new Error('no text answer after tool output')
    record('tool-call', true, `ping(${call.arguments}) → answer: "${text.trim().slice(0, 120)}"`)
  } catch (err) {
    record('tool-call', false, err.message)
  }

  // 3. audio-out ------------------------------------------------------------------------------
  let audio = Buffer.alloc(0)
  try {
    await updateSession(client, bus, { output_modalities: ['audio'], audio: { output: { voice: 'alloy' } }, tools: [] })
    const chunks = []
    let transcript = ''
    let firstAudioMs = null
    const t0 = Date.now()
    bus.on('response.output_audio.delta', (e) => {
      if (firstAudioMs === null) firstAudioMs = Date.now() - t0
      chunks.push(Buffer.from(e.delta, 'base64'))
    })
    bus.on('response.output_audio_transcript.delta', (e) => { transcript += e.delta ?? '' })
    client.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Sag bitte genau diesen Satz: Ich habe deinen Besuch bei Ferrero gefunden. Möchtest du ihn dokumentieren?' }] } })
    client.send({ type: 'response.create' })
    await bus.waitFor('response.done (audio)', isType('response.done'))
    bus.off('response.output_audio.delta'); bus.off('response.output_audio_transcript.delta')

    audio = Buffer.concat(chunks)
    if (!audio.length) throw new Error('no audio received')
    mkdirSync(OUT_DIR, { recursive: true })
    const file = join(OUT_DIR, 'assistant-answer.wav')
    writeFileSync(file, wavFromPcm16(audio))
    record('audio-out', true, `${(audio.length / 2 / SAMPLE_RATE).toFixed(1)} s audio, first chunk after ${firstAudioMs} ms, transcript: "${transcript.trim().slice(0, 100)}", file: ${file}`)
  } catch (err) {
    record('audio-out', false, err.message)
  }

  // 4. transcribe (optional) – built-in input transcription, one attempt per model ---------------
  for (const model of TRANSCRIBE_MODELS) {
    const step = `transcribe:${model}`
    if (!audio.length) { record(step, false, 'skipped – no audio from step 3', true); continue }
    try {
      await updateSession(client, bus, {
        output_modalities: ['text'],
        audio: { input: { format: { type: 'audio/pcm', rate: SAMPLE_RATE }, transcription: { model }, turn_detection: null } }
      })
      appendAudio(client, audio)
      client.send({ type: 'input_audio_buffer.commit' })
      const ev = await bus.waitFor(`input transcription (${model})`, (t) =>
        t === 'conversation.item.input_audio_transcription.completed' || t === 'conversation.item.input_audio_transcription.failed')
      if (ev.type === 'conversation.item.input_audio_transcription.failed' || ev.error) {
        throw new Error(`transcription failed: ${ev.error?.code ?? ''} ${ev.error?.message ?? JSON.stringify(ev)}`)
      }
      record(step, true, `"${(ev.transcript ?? '').trim().slice(0, 120)}"`, true)
    } catch (err) {
      record(step, false, err.message, true)
    }
  }

  // 4b. oob-transcribe (optional) – gpt-realtime itself transcribes a committed audio item -------
  //     in an out-of-band response (conversation: 'none'), without a separate transcription model.
  if (audio.length) {
    try {
      await updateSession(client, bus, {
        output_modalities: ['text'],
        audio: { input: { format: { type: 'audio/pcm', rate: SAMPLE_RATE }, transcription: null, turn_detection: null } }
      })
      appendAudio(client, audio)
      client.send({ type: 'input_audio_buffer.commit' })
      const committed = await bus.waitFor('input_audio_buffer.committed', isType('input_audio_buffer.committed'))
      let text = ''
      bus.on('response.output_text.delta', (e) => { text += e.delta ?? '' })
      const t0 = Date.now()
      client.send({
        type: 'response.create',
        response: {
          conversation: 'none',
          output_modalities: ['text'],
          metadata: { purpose: 'transcription' },
          instructions: 'Transkribiere die referenzierte Audioeingabe wörtlich in ihrer Originalsprache. Gib ausschließlich den transkribierten Text aus, ohne Kommentar.',
          input: [{ type: 'item_reference', id: committed.item_id }]
        }
      })
      await bus.waitFor('response.done (oob transcription)', isType('response.done'))
      bus.off('response.output_text.delta')
      if (!text.trim()) throw new Error('no transcription text returned')
      record('oob-transcribe', true, `${Date.now() - t0} ms: "${text.trim().slice(0, 120)}"`, true)
    } catch (err) {
      record('oob-transcribe', false, err.message, true)
    }
  } else {
    record('oob-transcribe', false, 'skipped – no audio from step 3', true)
  }

  // 5. server-vad (optional) --------------------------------------------------------------------
  if (audio.length) {
    try {
      await updateSession(client, bus, {
        audio: { input: { format: { type: 'audio/pcm', rate: SAMPLE_RATE }, turn_detection: { type: 'server_vad', create_response: false } } }
      })
      appendAudio(client, Buffer.concat([Buffer.alloc(SAMPLE_RATE), audio, Buffer.alloc(SAMPLE_RATE * 3)])) // 0.5 s silence + speech + 1.5 s silence
      await bus.waitFor('speech_started', isType('input_audio_buffer.speech_started'))
      await bus.waitFor('speech_stopped', isType('input_audio_buffer.speech_stopped'))
      record('server-vad', true, 'speech_started and speech_stopped received', true)
    } catch (err) {
      record('server-vad', false, err.message, true)
    }
  } else {
    record('server-vad', false, 'skipped – no audio from step 3', true)
  }

  finish(client)
}

function finish (client) {
  try { client?.close() } catch { /* ignore */ }
  console.log('\n===== SUMMARY (please send this block back) =====')
  console.table(results)
  const mandatoryFailed = results.some(r => r.result === 'FAIL')
  process.exit(mandatoryFailed ? 1 : 0)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  record('unexpected', false, err.message)
  finish()
})
