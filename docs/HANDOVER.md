# Übergabe: Voice-Assistent zur Visit-Dokumentation (SAP CAP + SAP Sales Cloud V1)

Stand: 17.11.2026. Phase 1 ist fertig und getestet. Phase 2 ist geschrieben, aber noch nicht getestet.

## 1. Ziel und verbindliche Regeln

Außendienstler dokumentieren nach einem Kundenbesuch per Sprachdialog (Speech-to-Speech) einen **bestehenden** C4C-Visit. Der Assistent erzeugt außerdem Folge-Tasks. Die Architektur ist eine Side-by-Side-Erweiterung auf SAP BTP.

**Nicht verhandelbar:**
- **Keine neuen Visits.** Es wird nur ein bestehender Visit verwendet. Der Visit wird nie geraten.
- **Kein Schreiben ohne Bestätigung.** C4C wird erst nach ausdrücklicher Bestätigung des Users geändert.
- **Die KI greift nie direkt auf C4C zu.** Alles läuft über CAP → BTP Destination → C4C. Es gibt kein generisches „OData ausführen“-Tool.
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
| C4C-Authentifizierung | technischer User mit BasicAuthentication in der Destination `SAP_Sales_Cloud_V1` (URL nur Host, Pfad `/sap/c4c/odata/v1/c4codataapi`). CAP muss Owner/Organizer **selbst** prüfen und den echten User in HANA bzw. der DB protokollieren. |
| Bestätigung | **nur per Sprache.** Schutz durch einen CAP-Preview-Hash (eingefrorener Entwurf, jede Änderung macht ihn ungültig). Zusätzlich prüft CAP selbst im Transkript der letzten User-Äußerung, ob sie eine eindeutige Zustimmung war. |
| Sprachen | automatisch Deutsch oder Englisch, je nachdem wie der User spricht. Begrüßung auf Deutsch, C4C-Texte in der Gesprächssprache (Annahme). |
| Audio | **wird nicht gespeichert**, nur live verarbeitet |
| Datenbank | **SQLite überall, auch auf Cloud Foundry**. HANA Cloud wird nicht verwendet. Das Risiko ist akzeptiert (R2). |
| BTP | Space `AI_DEV`. Entitlements: xsuaa `application`, destination `lite`, hdi-shared, html5-apps-repo. Eigener App Router als MTA-Modul, der die UI direkt ausliefert. Kein HTML5 Repo, keine dynamic destinations. |
| KI | SAP AI Core / Generative AI Hub, Resource Group `default`, Modell `gpt-realtime`. Transkription über `whisper-1`. Fallback: Out-of-band-Transkription durch `gpt-realtime`. |
| Architektur der Sprachschicht | Browser ⇄ WebSocket ⇄ App Router ⇄ CAP-Bridge ⇄ AI Core. Die Tool-Aufrufe der KI kommen serverseitig in CAP an. Der Browser kann keine Tools aufrufen. |

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
| `package.json` | CAP 10 (ESM). Abhängigkeiten: `@cap-js/sqlite` (Laufzeit, `:memory:`), `@cap-js/cds-test` (dev). `cds.requires.c4c` ist ein odata-v2-Remote-Service auf die Destination. Mock-User für die Entwicklung: alice und carol mit Rolle `VisitDocumenter`, bob ohne Rolle. `cds.voice` enthält Konfiguration (Aufbewahrung 7 Tage, AI-Core-Modell, Resource Group). `@cap-js/hana` wurde entfernt. |
| `db/schema.cds` | VoiceSessions, TranscriptEntries, VisitDrafts, TaskDrafts, CommitConfirmations, CommitOperations (Idempotenz, eindeutiger `idempotencyKey`) und AuditLog (nur Metadaten). Konvention: `c4c*` = von CAP gegen C4C geprüft, `proposed*` = Vorschlag der KI. |
| `srv/voice-service.cds` | `VoiceAssistantService`, `@protocol:'none'` (nicht über HTTP erreichbar), `@requires:'VisitDocumenter'`. Alle Tools geben `ToolResult {ok, code, message, data(JSON)}` zurück. |
| `srv/voice-service.js` | Umgesetzt: startSession (mit Mitarbeiter-Zuordnung), cancelSession, findVisit, selectVisit, getVisitContext, resolveEmployee, Besitzprüfung der Sitzung, Audit. **Noch 501:** updateVisitDraft, addTaskDraft, updateTaskDraft, removeTaskDraft, prepareCommitPreview, confirmCommit. |
| `srv/lib/c4c-client.js` | einzige Stelle mit C4C-Abfragen. `setTransport()` ist die Test-Schnittstelle. Owner/Organizer-Abfrage in zwei Queries, Prüfung auf aktive Mitarbeiter. |
| `srv/lib/c4c-codes.js` | alle bestätigten Code-Werte mit Quellenangabe |
| `srv/lib/time.js` | Tagesgrenzen in der Zeitzone (inklusive Zeitumstellung), OData-Datumswerte |
| `srv/lib/validation.js`, `srv/lib/tool-result.js` | Eingabeprüfung und Ergebnisformat |
| `test/phase1-foundation.test.js` | 9 Tests, **grün in BAS** |
| `test/phase2-c4c-read.test.js` | ca. 20 Tests, **noch nicht ausgeführt** |
| `test/mocks/c4c-mock.js` | C4C-Mock im Speicher (eq/ge/lt, lehnt `or` ab, Antworten in OData-V2-Form) |
| `spikes/aicore-realtime/` | erfolgreicher Spike zu AI Core Realtime, Ergebnisse in der README. Nutzt `@sap-ai-sdk/openai/realtime` (`SapOpenAiRealtimeWs.createClient('gpt-realtime')`, experimentell, nur Node). Ergebnisse: Verbindung ca. 800 ms, erster Ton 460–900 ms, Tool-Calls, Server-VAD, `whisper-1` und OOB-Transkription funktionieren. `gpt-4o-*-transcribe` liefert `DeploymentNotFound`. |
| `docs/c4c-metadata/` | bestätigte Metadaten-Ausschnitte, Code-Listen und Beispiel-GET (bereinigt) |
| `docs/open-security-risks.md` | R1: Destination hat `HTML5.DynamicDestination=true` (akzeptiert). R2: SQLite auf CF, flüchtig, nur 1 Instanz (akzeptiert). P1: Aufbewahrung des Transkripts (vorläufig). |
| `mta.yaml` | **noch unverändert** aus dem Generator (enthält noch HDB-Deployer und HDI). Wird in Phase 9 angepasst. |

## 5. Was als Nächstes offen ist

1. **Phase-2-Tests in BAS ausführen** (`git pull`, `npm test`) und Fehler beheben.
2. **Echter Lesetest gegen C4C** (Tenant `my347080`, technischer User). Dafür in BAS `npm add @sap-cloud-sdk/http-client` (Voraussetzung für CAP-Remote-Services) und eine Anbindung an die Destination, z. B. per `cds bind` oder lokaler Konfiguration ohne Commit. Zu prüfen: Antwortformat des Remote-Service (`d.results` oder bereits entpackt, `__metadata.etag` vorhanden?), URL-Kodierung der `$filter`-Werte, Groß-/Kleinschreibung der E-Mail.
3. **Phase 3:** updateVisitDraft (Zusammenfassung, Endzeit mit Validierung), prepareCommitPreview (Vorlese-Text und SHA-256-Hash über den eingefrorenen Entwurf), confirmCommit (Hash-Prüfung und Prüfung der Zustimmung im Transkript).
4. **Phase 4:** Task-Entwürfe (add/update/remove), dabei den Processor bei jeder Änderung neu auflösen. Commit der Tasks mit CommitOperations (Idempotenz) und **Duplikatsprüfung in C4C vor dem Anlegen** (wegen SQLite). Ehrliche Meldung von Teilfehlern.
5. **Phase 5:** PDFs mit `pdf-lib` (Standard-Fonts, Umlaute über WinAnsi), Anhänge, PATCH für Endzeit und Status mit frisch gelesenem ETag.
6. **Phase 6:** WebSocket-Bridge in CAP (`ws`) zu AI Core mit `@sap-ai-sdk/openai`. Dazu Prompt (DE/EN, Datenschutz-Hinweis beim Start), Tool-Definitionen für die KI, Transkripte in `TranscriptEntries`, Unterbrechen (Barge-in).
7. **Phase 7:** Mikrofon-UI mit den Zuständen hören / denken / sprechen, Aufnahme-Anzeige, Stopp, Erfolg/Fehler. Besonderheiten auf iOS: HTTPS, Start erst nach Tippen.
8. **Phase 8:** Ende-zu-Ende-Tests und echter Lauf mit dem User. Als Test-Processor wird immer der User selbst verwendet.
9. **Phase 9:** `mta.yaml` (App Router, XSUAA, Destination, AI-Core-Binding, HDB/HDI entfernen, 1 Instanz), `xs-security.json`, `@sap/xssec`, Löschjob für abgelaufene Sitzungen. Prüfen, wie die Login-E-Mail bei XSUAA ankommt (`req.user.attr.email`?). `package-lock.json` jeweils aus BAS committen.

**Offene Punkte beim User (nicht blockierend):**
- Name der AI-Core-Instanz in `AI_DEV` (für Phase 9)
- Bestätigung, dass `DocumentType 0006` der Standard-Tasktyp ist
- Default-Processor, wenn niemand genannt wird (angenommen: der User selbst)
- Mitarbeiter ohne gültigen Benutzer bekommen keine Tasks (angenommen)
- Freigabe durch den Datenschutz zu P1 und Entscheidung zu R1/R2 vor dem Go-live
