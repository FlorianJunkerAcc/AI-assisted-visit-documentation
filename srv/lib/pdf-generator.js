// Generates PDFs for the commit step using pdf-lib (standard fonts, WinAnsi-safe).
// German umlauts (ä ö ü Ä Ö Ü ß) are in the Latin-1 range and work with Helvetica.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { formatLocalDate, formatLocalTime } from './time.js'

const PAGE_W = 595.28  // A4
const PAGE_H = 841.89  // A4
const MARGIN = 50
const BODY_W = PAGE_W - 2 * MARGIN
const FS = 10        // body font size
const FS_TITLE = 13  // title font size
const LH = 14        // line height

async function newDoc () {
  const doc = await PDFDocument.create()
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  return { doc, regular, bold }
}

// Helvetica can only encode WinAnsi. drawText throws on anything else (emoji, other scripts,
// control characters), which would make the whole attachment fail – so replace those.
function sanitize (text, font) {
  const supported = new Set(font.getCharacterSet())
  return Array.from(String(text ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, ' '),
    c => c === '\n' || supported.has(c.codePointAt(0)) ? c : '?').join('')
}

function wrapText (text, font, size, maxWidth) {
  const fits = (s) => font.widthOfTextAtSize(s, size) <= maxWidth
  const lines = []
  for (const para of sanitize(text, font).split('\n')) {
    if (!para) { lines.push(''); continue }
    let cur = ''
    for (let w of para.split(' ')) {
      const test = cur ? `${cur} ${w}` : w
      if (fits(test)) { cur = test; continue }
      if (cur) lines.push(cur)
      // a single word wider than the line (e.g. a long URL) is split by characters
      while (!fits(w) && w.length > 1) {
        let n = w.length - 1
        while (n > 1 && !fits(w.slice(0, n))) n--
        lines.push(w.slice(0, n))
        w = w.slice(n)
      }
      cur = w
    }
    if (cur) lines.push(cur)
  }
  return lines
}

/** Writes lines top to bottom and starts a new A4 page whenever the current one is full. */
class Painter {
  constructor (doc, regular, bold) {
    this.doc = doc; this.regular = regular; this.bold = bold
    this._newPage()
  }

  _newPage () {
    this.page = this.doc.addPage([PAGE_W, PAGE_H])
    this.y = PAGE_H - MARGIN
  }

  /** Starts a new page if fewer than `lines` lines are left. */
  ensure (lines = 1) {
    if (this.y - lines * LH < MARGIN) this._newPage()
  }

  _draw (text, font, size, indent = 0) {
    for (const l of wrapText(text, font, size, BODY_W - indent)) {
      this.ensure()
      this.y -= LH
      this.page.drawText(l, { x: MARGIN + indent, y: this.y, font, size, color: rgb(0, 0, 0) })
    }
  }

  title (text) { this._draw(text, this.bold, FS_TITLE) }
  line (text, indent = 0) { this._draw(text, this.regular, FS, indent) }
  wrapped (text, indent = 0) { this._draw(text, this.regular, FS, indent) }
  blank () { this.y -= LH } // the next _draw breaks the page if necessary
}

export async function generateSummaryPdf (draft, tasks, timeZone) {
  const { doc, regular, bold } = await newDoc()
  const p = new Painter(doc, regular, bold)

  const dateStr = draft.c4cPlannedStart ? formatLocalDate(timeZone, new Date(draft.c4cPlannedStart)) : ''
  const startStr = draft.c4cPlannedStart ? formatLocalTime(timeZone, new Date(draft.c4cPlannedStart)) : ''
  const endStr = (draft.proposedActualEnd ?? draft.c4cPlannedEnd)
    ? formatLocalTime(timeZone, new Date(draft.proposedActualEnd ?? draft.c4cPlannedEnd))
    : ''

  p.title('Besuchszusammenfassung')
  p.blank()
  p.line(`Konto: ${draft.c4cAccountName ?? ''}`)
  p.line(`Datum: ${dateStr}, ${startStr} - ${endStr}`)
  p.line(`Thema: ${draft.c4cSubject ?? ''}`)
  p.blank()
  p.line('Zusammenfassung:')
  p.wrapped(draft.proposedSummary ?? '', 10)

  if (tasks?.length) {
    p.blank()
    p.line('Folgeaufgaben:')
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]
      const proc = t.c4cProcessorName ? ` (${t.c4cProcessorName})` : ''
      p.line(`${i + 1}. ${t.proposedSubject ?? ''}${proc}`)
      if (t.proposedDueDate) p.line(`   Faellig: ${t.proposedDueDate}`, 10)
    }
  }

  return doc.save()
}

export async function generateTranscriptPdf (draft, entries, timeZone) {
  const { doc, regular, bold } = await newDoc()
  const p = new Painter(doc, regular, bold)

  const dateStr = draft.c4cPlannedStart ? formatLocalDate(timeZone, new Date(draft.c4cPlannedStart)) : ''

  p.title('Transkript - KI-gestützte Besuchsdokumentation')
  p.blank()
  p.line(`Konto: ${draft.c4cAccountName ?? ''}`)
  p.line(`Datum: ${dateStr}`)
  p.blank()

  for (const entry of (entries ?? [])) {
    const role = entry.role === 'user' ? 'Nutzer' : 'Assistent'
    p.ensure(2) // keep the speaker label together with the first line of the text
    p.line(`[${role}]`)
    p.wrapped(entry.text ?? '', 10)
    p.blank()
  }

  return doc.save()
}
