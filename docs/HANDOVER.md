# Übergabe: Voice-Assistent zur Visit-Dokumentation (SAP CAP + SAP Sales Cloud V1)

Stand: 25.11.2026. Phasen 1–9 sind implementiert. App läuft lokal mit echtem AI Core und C4C (`cds watch --profile hybrid`). E2E-Test läuft. 75 Unit-Tests noch nicht in BAS ausgeführt. Deployment auf BTP steht aus.

---

## 1. Ziel und verbindliche Regeln

Außendienstler dokumentieren nach einem Kundenbesuch per Sprachdialog (Speech-to-Speech) einen **bestehenden** C4C-Visit. Der Assistent erzeugt außerdem Folge-Tasks. Die Architektur ist eine Side-by-Side-Erweiterung auf SAP BTP.

**Nicht verhandelbar:**
- **Keine neuen Visits.** Es wird nur ein bestehender Visit verwendet. Der Visit wird nie geraten.
- **Kein Schreiben ohne Bestätigung.** C4C wird erst nach ausdrücklicher Bestätigung des Users geändert.
- **Die KI greift nie direkt auf C4C zu.** Alles läuft über CAP → BTP Destination → C4C. Es gibt kein generisches „OData ausführen"-Tool.
- **Keine Secrets im Frontend oder im Repo.**
- **Keine C4C-Details raten.** Das gilt für EntitySets, Felder, Codes und Payloads. Bei Unklarheit den User nach dem **kleinsten** `$metadata`-Ausschnitt fragen. Bestätigte Werte stehen in `docs/c4c-metadata/`.
- **Außerhalb des Scopes:** neue Visits, Opportunities, Leads, Sales Orders, formularlastige UI.
- **Platzhalter nie als fertig ausgeben.** Nicht umgesetzte Tools antworten mit 501.
- **Arbeitsweise:** Der User **committet und pusht selbst**, die KI committet nie. Tests laufen in **SAP BAS** (`git pull`, `npm install`, `npm test`). Auf dem lokalen Windows-Rechner ist kein Node installiert. Rückfragen einzeln stellen, jeweils mit FRAGE / WARUM / WO FINDEN / BEISPIEL / BLOCKIEREND. Kommunikation auf Deutsch.

## 2. Getroffene Entscheidungen

| Thema | Entscheidung |
|---|---|
| Start der App | eigener Link, kein C4C-Mashup. Desktop, iOS und Android im Browser. |
| Visit-Suche | User ist Owner **oder** Organizer, `Status = '1'` (Open), Start heute in der Zeitzone des Geräts, nicht gelöscht |
| Mehrere Treffer | Die KI fragt nach. Es gibt **keine** Liste in der UI, nur Sprache. |
| Kein Treffer | Abbrechen mit dem Hinweis, dass der Visit zuerst in der SAP Sales Cloud angelegt werden muss |
| Beim Speichern am Visit | 1. PDF Zusammenfassung, 2. PDF Transkript, 3. `ActualEndDateTime`, 4. `Status = '3'` (Completed) **als letzter Schritt**. Keine Text-Notiz. |
| Tatsächliche Endzeit | Die KI fragt nach. Fallback ist die geplante `EndDateTime`. Prüfung: am Visit-Tag und nicht in der Zukunft. |
| Folge-Task | Processor = der genannte Kollege, Owner = der angemeldete User. Wird niemand genannt, ist der User Processor (Annahme, nicht bestätigt). Startdatum leer, Priorität immer `3`, Kategorie leer, `DocumentType 0006`. Dazu eine Beschreibung (Body Text) und eine Verknüpfung zum Visit. |
| User-Zuordnung | Login-E-Mail = C4C-`Employee.Email`, genau 1 aktiver Mitarbeiter. IdP ist der SAP ID Service (Standard). |
| C4C-Authentifizierung | technischer User mit BasicAuthentication in der Destination `SAP_Sales_Cloud_V1` (URL nur Host, Pfad `/sap/c4c/odata/v1/c4codataapi`). CAP muss Owner/Organizer **selbst** prüfen und den echten User in der DB protokollieren. |
| Bestätigung | **nur per Sprache.** Schutz durch einen CAP-Preview-Hash (eingefrorener Entwurf, jede Änderung macht ihn ungültig). Zusätzlich prüft CAP selbst im Transkript der letzten User-Äußerung, ob sie eine eindeutige Zustimmung war. |
| Commit-Strategie | Synchron in `confirmCommit`. `runCommit` führt alle C4C-Writes der Reihe nach aus. Jede Operation hat einen eindeutigen `idempotencyKey` → bei Wiederholung wird sie übersprungen (SUCCEEDED/SKIPPED_EXISTING). |
| PDFs | `pdf-lib` v1.17.1, StandardFonts.Helvetica (WinAnsi-sicher für Umlaute). Zusammenfassung und Transkript als zwei separate PDFs, beide via `VisitAttachmentCollection` angehängt. |
| Sprachen | automatisch Deutsch oder Englisch, je nachdem wie der User spricht. Begrüßung auf Deutsch, C4C-Texte in der Gesprächssprache (Annahme). |
| Audio | **wird nicht gespeichert**, nur live verarbeitet. Browser sendet PCM16 mono 24 kHz, empfängt PCM16 mono 24 kHz. |
| Datenbank | **SQLite überall, auch auf Cloud Foundry**. HANA Cloud wird nicht verwendet. Das Risiko ist akzeptiert (R2). |
| BTP | Space `AI_DEV`. Entitlements: xsuaa `application`, destination `lite`. Eigener App Router als MTA-Modul, der die UI direkt ausliefert. Kein HTML5 Repo, keine dynamic destinations. |
| KI | SAP AI Core / Generative AI Hub, Resource Group `default`, Modell `gpt-realtime`. Transkription über `whisper-1`. Fallback: Out-of-band-Transkription durch `gpt-realtime`. |
| Architektur der Sprachschicht | Browser ⇄ WebSocket ⇄ App Router ⇄ CAP-Bridge ⇄ AI Core. Die Tool-Aufrufe der KI kommen serverseitig in CAP an. Der Browser kann keine Tools aufrufen. |
| WebSocket-Auth | Browser kann beim WS-Upgrade keinen `Authorization`-Header senden. Lösung: Browser ruft zuerst `GET /api/voice-token` auf (XSUAA/mocked, 60 s TTL, one-time), öffnet dann `/ws/voice?token=<uuid>`. |
| sessionId-Sicherheit | Die KI sieht die `sessionId` nie. Die Bridge injiziert sie vor jedem Tool-Aufruf. Kein Tool hat `sessionId` als Parameter. |
| Token-Endpoint-Auth | Route ist in `cds.on('served', ...)` registriert, also **nach** CAP's Auth-Middleware. `req.user` ist gesetzt (mocked auth in dev, XSUAA JWT in prod). Kein manuelles Basic-Auth-Parsing mehr. |
| Browser-Mikrofon | `ScriptProcessorNode` (deprecated, aber überall verfügbar, kein separates Worker-File nötig), 4096 Samples, 24 kHz → Float32 → Int16 → binäre WS-Frames. |

## 3. Bestätigte C4C-Zuordnung (`c4codataapi`, OData V2)

Die Quellen liegen in `docs/c4c-metadata/`, die Konstanten in `srv/lib/c4c-codes.js`.

- **Visit:** `VisitCollection`, Schlüssel `ObjectID`.
  - Suchfelder: `OwnerEmailURI`, `OrganizerEmailURI`, `Status`, `StartDateTime`, `MarkedForDeletion`.
  - Account-GUID im Feld `Account` (entspricht `Tasks.AccountUUID`).
  - `ETag` hat `ConcurrencyMode=Fixed`, also wird `If-Match` benötigt.
- **Status:** 1 Open, 2 In Process, 3 Completed, 4 Canceled
- **Anhang:** `POST VisitAttachmentCollection` mit `ParentObjectID` = Visit-`ObjectID`, `CategoryCode "2"` (Document), `TypeCode "10009"` (Summary-PDF) bzw. `"10001"` (Transkript-PDF), `Name`, `MimeType application/pdf`, `Binary` (Base64)
- **Mitarbeiter:** `EmployeeCollection`.
  - `Employee.UUID` = `Tasks.OwnerUUID`/`ProcessorUUID`.
  - `Employee.BusinessPartnerID` = `Tasks.ProcessorPartyID`.
  - `EmployeeID` ist ein anderer Wert und wird nicht verwendet.
  - Aktiv heißt: Mitarbeiter- **und** Benutzer-Gültigkeit umfassen heute, und `UserLockedIndicator` ist nicht `true`.
- **Task:** `POST TasksCollection` mit `Subject`, `DocumentType "0006"`, `PriorityCode "3"`, `DueDateTime` (UTC) + `DueDatetimeZoneCode "UTC"`, `AccountUUID`, `OwnerUUID`, `ProcessorUUID`
  - Beschreibung: `TasksTextCollection` mit `TypeCode "10002"` und `Text`. `LanguageCode` bleibt leer, die Codes sind nicht geprüft.
  - Verknüpfung: `TasksBTDReferenceCollection` mit `ParentObjectID` = Task, `ID` = **Visit.ID** (nicht ObjectID), `TypeCode "12"` (Appointment, **nicht** 2054), `BTDRoleCode "1"` (Predecessor). Das entspricht dem, was C4C selbst einträgt.
- **Einschränkung:** C4C lehnt `$filter` mit `or` über **verschiedene** Properties ab. Lösung: zwei Abfragen und in CAP zusammenführen.
- **Noch ungeprüft:** ob ein POST über die Navigation auf `TasksTextCollection` funktioniert, ob ein Deep Insert möglich ist und ob Status und Endzeit in einem einzigen PATCH gehen. Das muss beim ersten echten Lauf getestet werden.

## 4. Wichtige Dateien

| Datei | Inhalt |
|---|---|
| `package.json` | CAP 10 (ESM). Abhängigkeiten: `@cap-js/sqlite` (`:memory:`), `pdf-lib ^1.17.1`, `@sap-ai-sdk/openai ^2.15.0`, `ws ^8`, `@sap/xssec ^3`. Mock-User: alice und carol mit Rolle `VisitDocumenter`, bob ohne Rolle. `cds.voice` enthält AI-Core-Konfiguration. `[production].auth.kind = xsuaa`. `[development]` und `[hybrid]` verwenden beide mocked-Auth mit denselben Usern (hybrid für `cds watch --profile hybrid`). |
| `db/schema.cds` | VoiceSessions, TranscriptEntries, VisitDrafts, TaskDrafts, CommitConfirmations, CommitOperations (Idempotenz, eindeutiger `idempotencyKey`) und AuditLog. Konvention: `c4c*` = von CAP geprüft, `proposed*` = Vorschlag der KI. |
| `srv/voice-service.cds` | `VoiceAssistantService`, `@protocol:'none'` (nicht über HTTP erreichbar), `@requires:'VisitDocumenter'`. Alle Tools geben `ToolResult {ok, code, message, data(JSON)}` zurück. |
| `srv/voice-service.js` | Alle 10 Tools vollständig implementiert (kein 501 mehr): startSession, cancelSession, findVisit, selectVisit, getVisitContext, resolveEmployee, updateVisitDraft, addTaskDraft, updateTaskDraft, removeTaskDraft, prepareCommitPreview, confirmCommit. `runCommit` führt alle C4C-Writes synchron mit Idempotenzprüfung aus. |
| `srv/lib/c4c-client.js` | einzige Stelle mit C4C-Abfragen und -Writes. `setTransport()` ist die Test-Schnittstelle. Lesend: findVisitsByOwner, findVisitsByOrganizer, getVisit, findEmployeeByEmail, findEmployeesByName. Schreibend: patchVisit, createTask, createTaskDescription, createTaskVisitLink, createVisitAttachment. |
| `srv/lib/pdf-generator.js` | `generateSummaryPdf` und `generateTranscriptPdf` mit `pdf-lib` StandardFonts.Helvetica. A4, 50 pt Rand, automatischer Zeilenumbruch. Gibt `Uint8Array` zurück. |
| `srv/lib/ai-tools.js` | `SYSTEM_PROMPT` (Deutsch, 11 Regeln, Workflow-Ablauf, bewusst ohne Datenschutz-Hinweis) und `AI_TOOLS` (10 OpenAI function-tool-Definitionen). Kein `sessionId` in irgendwelchen Tool-Parametern — Bridge injiziert es. |
| `srv/voice-bridge.js` | WebSocket-Bridge: Browser ⇄ CAP ⇄ AI Core. OTP-Token-Store (60 s TTL). `registerVoiceBridge(httpServer)` hängt sich ans `upgrade`-Event. `handleVoiceConnection` verwaltet AI-Core-Client, Tool-Dispatch, Transkript-Speicherung, Binary-Relay. |
| `srv/server.js` | CAP-Bootstrap: registriert `GET /api/voice-token` im `'served'`-Hook (nach Auth-Middleware, `req.user` ist gesetzt). Dev-only-Fallback: wenn `req.user` leer und `NODE_ENV !== 'production'`, wird `?_dev_user=alice` akzeptiert (BAS-Tunnel filtert `Authorization`-Header heraus). Hängt Bridge an `listening`-Event. |
| `srv/lib/c4c-codes.js` | alle bestätigten Code-Werte mit Quellenangabe |
| `srv/lib/time.js` | Tagesgrenzen in der Zeitzone (inklusive Zeitumstellung), OData-Datumswerte |
| `srv/lib/validation.js`, `srv/lib/tool-result.js` | Eingabeprüfung und Ergebnisformat |
| `app/index.html` | Einzel-Datei-UI ohne externe Dependencies. Credentials-Felder sind standardmäßig versteckt; bei 401 auf `/api/voice-token` erscheinen sie automatisch. Bei weiterem 401 (BAS-Tunnel filtert Basic-Auth) wird automatisch `?_dev_user=<username>` als Fallback verwendet. In Produktion (App Router + XSUAA) werden Felder nie angezeigt. WebSocket, PCM16-Mikrofon via `ScriptProcessorNode`, PCM16-Wiedergabe via `AudioContext`. |
| `app/xs-app.json` | App-Router-Routing: `/api/voice-token` → XSUAA-Authentifizierung, `/ws/voice` → kein Auth + WebSocket-Upgrade, `/api/*` → XSUAA, `/*` → statische Dateien aus `app/`. |
| `app/package.json` | App-Router-Abhängigkeit: `@sap/approuter ^16`. |
| `mta.yaml` | Deployment-Deskriptor: CAP srv-Modul (1 Instanz, 512 MB), App-Router-Modul (1 Instanz, 128 MB). Ressourcen: XSUAA (xsuaa/application, `xs-security.json`), Destination (destination/lite), AI Core (existing-service `aicore`). Kein HDI, kein HDB-Deployer. |
| `xs-security.json` | XSUAA-Konfiguration: Scope `VisitDocumenter`, RoleTemplate `VisitDocumenter`, RoleCollection `VisitDocumenter`. Token-Gültigkeit 12 h, Refresh-Token 30 Tage. |
| `test/phase1-foundation.test.js` | 8 Tests, **grün in BAS** |
| `test/phase2-c4c-read.test.js` | 18 Tests, **grün in BAS** |
| `test/phase3-draft.test.js` | 19 Tests, noch nicht in BAS nach letztem `git pull` ausgeführt |
| `test/phase4-tasks.test.js` | 15 Tests, **grün in BAS** |
| `test/phase5-commit.test.js` | 8 Tests, **grün in BAS** |
| `test/phase6-bridge.test.js` | 7 Tests (Tool-Definitionen, Prompt, Token-Generierung), **noch nicht in BAS ausgeführt** |
| `test/mocks/c4c-mock.js` | C4C-Mock im Speicher (GET, PATCH, POST). `created.{tasks,taskTexts,taskReferences,attachments}` wird nach jedem Test zurückgesetzt. |
| `spikes/aicore-realtime/` | erfolgreicher Spike zu AI Core Realtime. Verbindung ca. 800 ms, erster Ton 460–900 ms, Tool-Calls, Server-VAD, `whisper-1` funktionieren. |
| `docs/c4c-metadata/` | bestätigte Metadaten-Ausschnitte, Code-Listen und Beispiel-GET |
| `docs/open-security-risks.md` | R1: Destination hat `HTML5.DynamicDestination=true` (akzeptiert). R2: SQLite auf CF, flüchtig, nur 1 Instanz (akzeptiert). P1: Aufbewahrung des Transkripts (vorläufig). |

## 5. Was als Nächstes offen ist

### Kurzfristig (in BAS erledigen)

1. **75 Unit-Tests in BAS ausführen:**
   ```bash
   git pull
   npm install
   npm install --prefix app
   npm test
   ```
   Erwartet: 75 Tests grün (Phasen 1–6). Anschließend `package-lock.json` und `app/package-lock.json` committen und pushen.

2. **E2E-Test vollständig durchlaufen** (`cds watch --profile hybrid`):
   - Besuch finden und bestätigen
   - Zusammenfassung diktieren, Endzeit nennen
   - Optionalen Task anlegen
   - Vorschau bestätigen → Commit

   Zu prüfen und nach dem Lauf in HANDOVER zu vermerken:
   - [ ] C4C-Antwortformat korrekt entpackt (`d.results`, `__metadata.etag`)
   - [ ] URL-Kodierung der `$filter`-Werte funktioniert
   - [ ] Status und Endzeit gehen in einem einzigen PATCH
   - [ ] `DocumentType 0006` wird akzeptiert
   - [ ] PDFs werden korrekt angehängt

### Mittelfristig

3. **Deployment auf BTP:**
   ```bash
   # In BAS:
   npm install -g mbt   # einmalig
   mbt build
   cf target -s AI_DEV
   cf deploy mta_archives/aiAssistedVisitDocumentation_1.0.0.mtar
   ```
   Nach dem Deploy im BTP Cockpit: RoleCollection `VisitDocumenter` dem User zuweisen.
   Dann testen: App-Router-URL aufrufen → XSUAA-Login → kein Credentials-Formular sichtbar.

**Offene Punkte beim User (nicht blockierend):**
- Bestätigung, dass `DocumentType 0006` der Standard-Tasktyp ist (wird beim E2E-Test geklärt)
- Default-Processor, wenn niemand genannt wird (angenommen: der User selbst)
- Mitarbeiter ohne gültigen Benutzer bekommen keine Tasks (angenommen)
- Freigabe durch den Datenschutz zu P1 und Entscheidung zu R1/R2 vor dem Go-live

**Lokale Testkonfiguration (nicht committen):**
- `.cdsrc-private.json`: AI-Core- und Destination-Bindings + `auth.users.alice.attr.email = florian.junker@accenture.com`
