# Spike: GPT Realtime via SAP AI Core

This is a throw-away technical check. It is **not** part of the application. It answers one question: can CAP (Node.js) hold a speech-to-speech session with the `gpt-realtime` deployment in SAP AI Core (resource group `default`)?

It uses the experimental Realtime client of the SAP Cloud SDK for AI: `@sap-ai-sdk/openai/realtime`, available since v2.15.0. That client supports WebSocket from Node.js only, not from the browser, which matches the planned CAP relay architecture.

## Checks

| # | Step | Mandatory | Proves |
|---|---|---|---|
| 1 | connect | yes | Deployment is resolved by model name and the WebSocket session opens |
| 2 | tool-call | yes | The model calls a function tool, gets the result and answers. This is the base for the CAP tools. |
| 3 | audio-out | yes | The model answers with audio. Reports the latency to the first audio chunk and writes `out/assistant-answer.wav`. |
| 4 | transcribe | optional | The audio from step 3 is sent back as user input, and the input transcription comes back. This is the base for the visit transcript. |
| 4b | oob-transcribe | optional | Fallback if step 4 fails. `gpt-realtime` itself transcribes the user audio in an out-of-band response, with no separate transcription model. |
| 5 | server-vad | optional | Server-side voice activity detection fires. This is the base for natural turn-taking and barge-in. |

## Run in SAP Business Application Studio

1. Get an **SAP AI Core service key** (JSON). It can come from either of these places:
   - SAP BTP Cockpit → Cloud Foundry → Spaces → `AI_DEV` → Instances → *SAP AI Core instance* → Service Keys → view (or create) a key → copy the JSON.
   - Or in the BAS terminal, after `cf login` and targeting space `AI_DEV`: `cf service-key <ai-core-instance> <key-name>`, then copy the JSON part.
2. In the BAS terminal:
   ```bash
   cd spikes/aicore-realtime
   npm install
   export AICORE_SERVICE_KEY='<paste the JSON on one line>'
   npm run spike
   ```
   Optional overrides:
   - `REALTIME_MODEL`: default `gpt-realtime`. Set it if the deployment uses a different model name.
   - `TRANSCRIBE_MODELS`: comma-separated, default `gpt-4o-mini-transcribe,gpt-4o-transcribe,whisper-1`. One attempt per model.
   - `STEP_TIMEOUT_MS`: default `30000`.
3. Send back the block printed under `===== SUMMARY =====`.
4. Optional: download `out/assistant-answer.wav` and listen to it.

## Results (run 2, 2026-11-17, BAS, resource group `default`)

| Step | Result | Details |
|---|---|---|
| connect | PASS | `session.created` after 814 ms (run 1: 782 ms) |
| tool-call | PASS | `ping({"value":42})`, correct follow-up answer in German |
| audio-out | PASS | first audio chunk after 906 ms (run 1: 462 ms), German speech is correct |
| transcribe: gpt-4o-mini-transcribe | FAIL | `DeploymentNotFound`, not available behind AI Core |
| transcribe: gpt-4o-transcribe | FAIL | `DeploymentNotFound` |
| transcribe: **whisper-1** | **PASS** | Verbatim and correct |
| oob-transcribe (gpt-realtime) | PASS | 1179 ms, verbatim and correct |
| server-vad | PASS | `speech_started` / `speech_stopped` received |

**Decisions:**
- Built-in input transcription uses **`whisper-1`**. It runs asynchronously and needs no extra request.
- Out-of-band transcription with `gpt-realtime` is the fallback if a whisper transcript is missing or failed.
- **Limitation of this spike:** the input audio was synthetic speech without background noise. A real microphone test (car, street, dialects) is part of phase 6 and 8.

**Never commit the service key.** `.env`, `*.key.json` and `out/` are git-ignored. After the spike, run `unset AICORE_SERVICE_KEY` or close the terminal.
