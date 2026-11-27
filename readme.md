# AI-assisted Visit Documentation

Voice assistant for field sales: document an existing visit in **SAP Sales Cloud V1** by talking instead of typing. A side-by-side extension on SAP BTP, built with SAP CAP (Node.js).

> **Status:** MVP, not yet deployed and not ready for production. See [known limitations](docs/DEVELOPER-DOCUMENTATION.md#9-known-limitations-and-open-items).

## What it does

- Finds today's open visits of the logged-in user
- Captures the meeting content and follow-up tasks in a speech-to-speech conversation (German, English possible)
- Shows a preview and saves only after the user confirms
- Attaches a summary PDF and a transcript PDF, creates and links tasks, sets the end time and completes the visit

It never creates new visits, and the AI has no direct access to Sales Cloud.

## Architecture

```
Browser ⇄ App Router ⇄ CAP application ⇄ SAP AI Core (gpt-realtime, whisper-1)
                              │
                              └─ OData V2 ─→ SAP Sales Cloud V1   (destination SAP_Sales_Cloud_V1)
```

Required services: Cloud Foundry runtime, XSUAA, Destination service, SAP AI Core (Generative AI Hub).

## Quick start

```bash
npm install
npm install --prefix app

cds watch                    # mocked auth, no backend bindings (UI and connection only)
cds watch --profile hybrid   # mocked auth, real Destination and AI Core bindings
```

For the `hybrid` profile, create the bindings with `cds bind`; they are stored in `.cdsrc-private.json`, which must not be committed. Local users: `alice` / `alice` (more in `package.json`).

## Tests

```bash
npm test
```

## UI bundle

`app/webapp/ui5.bundle.js` is generated and committed. Rebuild it after changes in `ui-src/`:

```bash
npm run build:ui
```

## Deployment

```bash
mbt build
cf deploy mta_archives/aiAssistedVisitDocumentation_1.0.0.mtar
```

Run `npm install` and commit `package-lock.json` first, then read the [deployment notes](docs/DEVELOPER-DOCUMENTATION.md#83-deployment-not-yet-performed). Assign the role collection `Z_VisitDocumenter` to users.

## Project layout

| Folder | Content |
|---|---|
| `app/` | App Router configuration; web UI in `app/webapp/` |
| `db/` | Data model |
| `srv/` | Voice bridge, business logic, C4C client, PDF generation |
| `test/` | Tests and C4C mock |
| `ui-src/` | Sources of the UI5 bundle |
| `docs/` | Documentation and confirmed C4C metadata |
| `spikes/` | Early proofs of concept |

## Documentation

- [Developer documentation and implementation plan](docs/DEVELOPER-DOCUMENTATION.md) – start here
- [Open security risks](docs/open-security-risks.md)
- [Handover notes](docs/HANDOVER.md) (German)
