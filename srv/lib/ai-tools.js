// System prompt and tool definitions sent to the gpt-realtime model.
// sessionId is intentionally absent from every tool – the bridge injects it.

export const SYSTEM_PROMPT = `
Du bist ein Sprachassistent für SAP Sales Cloud, der Außendienstmitarbeitern hilft, Kundenbesuche nach einem Gespräch zu dokumentieren.

Sprache: Du sprichst in der Sprache des Nutzers (Deutsch oder Englisch). Du beginnst auf Deutsch.

Ablauf:
1. Begrüße den Nutzer kurz auf Deutsch und nenne deine Aufgabe (Besuchsdokumentation). Rufe sofort findVisit auf.
2. Bei einem Treffer: lies ihn dem Nutzer vor und bitte um Bestätigung, rufe dann selectVisit auf. Bei mehreren: frage nach (Konto oder Uhrzeit), dann selectVisit. Bei keinem: informiere den Nutzer und beende das Gespräch höflich.
3. Frage: Was wurde besprochen? Was waren die wichtigsten Ergebnisse und Vereinbarungen?
4. Frage nach der tatsächlichen Endzeit (im Format HH:MM). Falls der Nutzer keine nennt, schlage vor, die geplante Endzeit zu verwenden.
5. Rufe updateVisitDraft mit Zusammenfassung und Endzeit auf.
6. Frage, ob es Folgeaufgaben gibt. Falls ja: Für jede Aufgabe Betreff, optionale Beschreibung, optionale Fälligkeit (JJJJ-MM-TT) und optionalen Zuständigen erfragen. Rufe addTaskDraft auf. Bei Namensunklarheit: Klärung erfragen, dann updateTaskDraft.
7. Rufe prepareCommitPreview auf und lies den zurückgegebenen Vorschautext wörtlich vor.
8. Frage explizit: "Soll ich das so speichern? Bitte antworten Sie mit Ja oder Nein."
9. Bei eindeutigem Ja: rufe confirmCommit mit dem Hash und der genauen Aussage des Nutzers auf.
10. Bei Nein oder Änderungswunsch: aktualisiere den Entwurf und wiederhole ab Schritt 7.
11. Nach erfolgreichem Speichern: informiere den Nutzer und verabschiede dich.

Regeln:
- Du erstellst NIEMALS einen neuen Besuch.
- Du rufst confirmCommit ERST auf, wenn der Nutzer klar zugestimmt hat (z. B. "Ja", "Speichern", "Einverstanden").
- visitObjectID und previewHash kommen ausschließlich aus Tool-Rückgaben, nie aus Schätzungen.
- Bei ok: false im Tool-Ergebnis: erkläre dem Nutzer kurz das Problem und schlage einen nächsten Schritt vor.
- Lies Ortsangaben, Kontonamen und Zusammenfassungen immer auf Deutsch vor, auch wenn der Nutzer Englisch spricht, es sei denn, der Nutzer bittet ausdrücklich um Englisch.
`.trim()

export const AI_TOOLS = [
  {
    type: 'function',
    name: 'findVisit',
    description: 'Sucht offene Besuche für den heutigen Tag. Erster Schritt in jedem Gespräch.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
  },
  {
    type: 'function',
    name: 'selectVisit',
    description: 'Wählt einen Besuch aus den findVisit-Ergebnissen aus. Nur mit einer visitId aus dem letzten findVisit-Ergebnis aufrufen.',
    parameters: {
      type: 'object',
      properties: {
        visitObjectID: { type: 'string', description: 'visitId aus dem findVisit-Ergebnis' }
      },
      required: ['visitObjectID'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'getVisitContext',
    description: 'Gibt die aktuellen Besuchsdetails zurück (Konto, Datum, Ort, Ansprechpartner). Optional zum Nachschlagen.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
  },
  {
    type: 'function',
    name: 'resolveEmployee',
    description: 'Prüft, ob ein genannter Mitarbeiter in SAP Sales Cloud bekannt ist. Vor addTaskDraft verwenden, wenn der Name mehrdeutig sein könnte.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name des Mitarbeiters, z. B. "Patrick" oder "Patrick Müller"' }
      },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'updateVisitDraft',
    description: 'Speichert Zusammenfassung und/oder Endzeit im Entwurf. Bei der Endzeit genau einen der beiden Parameter übergeben.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Kurze sachliche Zusammenfassung des Gesprächs (3–10 Sätze)' },
        actualEndTime: { type: 'string', description: 'Tatsächliche Endzeit als HH:MM in Ortszeit, z. B. "14:30"' },
        usePlannedEnd: { type: 'boolean', description: 'true: geplante Endzeit verwenden (wenn der Nutzer keine nennt)' }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'addTaskDraft',
    description: 'Legt einen neuen Folge-Task-Entwurf an.',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Kurzer Betreff der Aufgabe (max. 765 Zeichen)' },
        description: { type: 'string', description: 'Ausführlichere Beschreibung der Aufgabe (optional)' },
        dueDate: { type: 'string', description: 'Fälligkeitsdatum im Format JJJJ-MM-TT, z. B. "2026-11-30" (optional)' },
        processorName: { type: 'string', description: 'Name des Zuständigen wie gesprochen, z. B. "Patrick" oder "Patrick Müller". Leer lassen, wenn der angemeldete Nutzer zuständig ist.' }
      },
      required: ['subject'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'updateTaskDraft',
    description: 'Aktualisiert einen bestehenden Task-Entwurf. taskId aus dem addTaskDraft-Ergebnis verwenden.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'taskId aus dem addTaskDraft-Ergebnis' },
        subject: { type: 'string', description: 'Neuer Betreff (optional)' },
        description: { type: 'string', description: 'Neue Beschreibung (optional)' },
        dueDate: { type: 'string', description: 'Neues Fälligkeitsdatum JJJJ-MM-TT oder null zum Löschen (optional)' },
        processorName: { type: 'string', description: 'Neuer Zuständiger (optional)' }
      },
      required: ['taskId'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'removeTaskDraft',
    description: 'Entfernt einen Task-Entwurf. taskId aus dem addTaskDraft-Ergebnis verwenden.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'taskId aus dem addTaskDraft-Ergebnis' }
      },
      required: ['taskId'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'prepareCommitPreview',
    description: 'Erstellt den Vorschautext für die Bestätigung. Lies den zurückgegebenen previewText wörtlich vor.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
  },
  {
    type: 'function',
    name: 'confirmCommit',
    description: 'Schreibt alles in SAP Sales Cloud. Nur aufrufen, wenn der Nutzer eindeutig zugestimmt hat.',
    parameters: {
      type: 'object',
      properties: {
        previewHash: { type: 'string', description: 'previewHash aus dem letzten prepareCommitPreview-Ergebnis' },
        userUtterance: { type: 'string', description: 'Exakter Wortlaut der Zustimmung des Nutzers' }
      },
      required: ['previewHash', 'userUtterance'],
      additionalProperties: false
    }
  }
]
