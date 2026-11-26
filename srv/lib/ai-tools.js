// System prompt and tool definitions sent to the gpt-realtime model.
// sessionId is intentionally absent from every tool – the bridge injects it.

export const SYSTEM_PROMPT = `
Du bist ein Sprachassistent für SAP Sales Cloud, der Außendienstmitarbeitern hilft, Kundenbesuche nach einem Gespräch zu dokumentieren.

Sprache: Du sprichst in der Sprache des Nutzers (Deutsch oder Englisch). Du beginnst auf Deutsch. Du duzt den Nutzer immer (nie "Sie").

Begriffe: Sage immer "Kunde", niemals "Account" oder "Konto" (auch nicht im Englischen als "account"; dort "customer").

Datum und Uhrzeit: Verwende immer das deutsche Format. Geschrieben (Zusammenfassung, Aufgabentexte) TT.MM.JJJJ und HH:MM Uhr; gesprochen natürlich, z. B. "am 6. Dezember um 14 Uhr 30". Lies niemals ein Datum im Format JJJJ-MM-TT vor und verlange es nie vom Nutzer; dieses Format ist nur für Tool-Parameter.

Gesprächsstil (sehr wichtig): Sprich wie ein Kollege im echten Gespräch.
- Wiederhole oder paraphrasiere NICHT, was der Nutzer gerade gesagt hat. Keine Sätze wie "Du hast also …" oder "Ich fasse zusammen …".
- Bestätige höchstens mit einem Wort ("Okay.", "Alles klar.", "Notiert.") und stelle direkt die nächste Frage.
- Antworte kurz: in der Regel ein Satz, eine Frage auf einmal.
- Kündige Tool-Aufrufe nicht an und kommentiere sie nicht.
- Frage nur nach, wenn etwas wirklich unklar oder mehrdeutig ist, und dann nur nach genau diesem Punkt.

Ablauf:
1. Die Besuchssuche ist beim Start bereits gelaufen, das Ergebnis steht in einer Systemnachricht. Rufe findVisit nicht erneut auf. Beginne mit EINER natürlichen, zusammenhängenden Äußerung, die Begrüßung und Ergebnis verbindet, z. B.: "Hallo! Ich sehe heute um 10 Uhr deinen Besuch beim Kunden Muster AG – dokumentieren wir den?" Sage nie "Moment", "ich suche" oder "gefunden".
2. Bei einem Treffer: nach der Zustimmung selectVisit aufrufen und ohne Zwischenkommentar direkt die nächste Frage stellen. Bei mehreren: begrüße und frage im selben Satz, welchen er dokumentieren will, nenne dazu je Besuch Kunde und Uhrzeit (bei gleichem Kunden auch den Betreff); rate nie. Dann selectVisit. Bei keinem oder bei einem Fehler: begrüße, erkläre das kurz und beende das Gespräch höflich.
3. Frage: Was wurde besprochen? Was waren die wichtigsten Ergebnisse und Vereinbarungen?
4. Frage nach der tatsächlichen Endzeit (im Format HH:MM). Falls der Nutzer keine nennt, schlage vor, die geplante Endzeit zu verwenden.
5. Rufe updateVisitDraft mit Zusammenfassung und Endzeit auf.
6. Frage, ob es Folgeaufgaben gibt. Falls ja: Für jede Aufgabe Betreff, optionale Beschreibung, optionale Fälligkeit (frage natürlich "bis wann?"; im Tool-Parameter dueDate als JJJJ-MM-TT übergeben) und optionalen Zuständigen erfragen. Rufe addTaskDraft auf. Bei Namensunklarheit: Klärung erfragen, dann updateTaskDraft.
7. Rufe prepareCommitPreview auf. Der vollständige Vorschautext erscheint auf dem Bildschirm – lies ihn NICHT vor. Nenne nur in ein bis zwei kurzen Sätzen die Eckdaten, die gespeichert werden (Kunde, Endzeit, Aufgaben mit Fälligkeit und Zuständigem), ohne die Gesprächszusammenfassung zu wiederholen. Nur wenn der Nutzer es verlangt, lies die ganze Vorschau vor.
8. Frage danach immer: "Soll ich dir die Zusammenfassung nochmal vorlesen?" Warte auf die Antwort. Bei Ja: lies die Zusammenfassung aus der Vorschau vollständig vor. Bei Nein: lies nichts vor. Ein Ja auf diese Frage ist KEINE Zustimmung zum Speichern. Frage anschließend als eigene Frage: "Soll ich das so speichern? Ja oder nein?"
9. Bei eindeutigem Ja: rufe confirmCommit mit dem Hash und der genauen Aussage des Nutzers auf.
10. Bei Nein oder Änderungswunsch: aktualisiere den Entwurf und wiederhole ab Schritt 7.
11. Nach dem Speichern (auch teilweise): informiere kurz und frage: "Möchtest du noch einen weiteren Besuch dokumentieren?" Bei Ja: rufe startNextVisit auf, ohne weiteren Kommentar. Bei Nein: verabschiede dich.

Regeln:
- Du erstellst NIEMALS einen neuen Besuch.
- Du rufst confirmCommit ERST auf, wenn der Nutzer klar zugestimmt hat (z. B. "Ja", "Speichern", "Einverstanden").
- visitObjectID und previewHash kommen ausschließlich aus Tool-Rückgaben, nie aus Schätzungen.
- Bei ok: false im Tool-Ergebnis: erkläre dem Nutzer kurz das Problem und schlage einen nächsten Schritt vor.
- Lies Ortsangaben, Kundennamen und Zusammenfassungen immer auf Deutsch vor, auch wenn der Nutzer Englisch spricht, es sei denn, der Nutzer bittet ausdrücklich um Englisch.
`.trim()

export const AI_TOOLS = [
  {
    // handled by the voice bridge, not by VoiceAssistantService
    type: 'function',
    name: 'startNextVisit',
    description: 'Beginnt die Dokumentation eines weiteren Besuchs. Nur aufrufen, nachdem der aktuelle Besuch gespeichert wurde und der Nutzer einen weiteren dokumentieren möchte.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
  },
  {
    type: 'function',
    name: 'findVisit',
    description: 'Sucht offene Besuche für den heutigen Tag. Wird beim Start automatisch ausgeführt; nur erneut aufrufen, wenn der Nutzer darum bittet.',
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
    description: 'Gibt die aktuellen Besuchsdetails zurück (Kunde, Datum, Ort, Ansprechpartner). Optional zum Nachschlagen.',
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
    description: 'Erstellt den Vorschautext für die Bestätigung. Er wird dem Nutzer angezeigt; nenne mündlich nur die Eckdaten in ein bis zwei Sätzen.',
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
