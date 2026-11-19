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

function wrapText (text, font, size) {
  const lines = []
  for (const para of String(text ?? '').split('\n')) {
    if (!para) { lines.push(''); continue }
    const words = para.split(' ')
    let cur = ''
    for (const w of words) {
      const test = cur ? `${cur} ${w}` : w
      if (font.widthOfTextAtSize(test, size) > BODY_W && cur) { lines.push(cur); cur = w } else cur = test
    }
    if (cur) lines.push(cur)
  }
  return lines
}

class Painter {
  constructor (page, regular, bold) {
    this.page = page; this.regular = regular; this.bold = bold
    this.y = PAGE_H - MARGIN
  }

  _draw (text, font, size, indent = 0) {
    if (this.y < MARGIN + LH) return
    this.y -= LH
    this.page.drawText(String(text ?? ''), { x: MARGIN + indent, y: this.y, font, size, color: rgb(0, 0, 0) })
  }

  title (text) { this._draw(text, this.bold, FS_TITLE) }
  line (text, indent = 0) { this._draw(text, this.regular, FS, indent) }
  blank () { if (this.y > MARGIN + LH) this.y -= LH }

  wrapped (text, indent = 0) {
    for (const l of wrapText(text, this.regular, FS)) this._draw(l, this.regular, FS, indent)
  }
}

export async function generateSummaryPdf (draft, tasks, timeZone) {
  const { doc, regular, bold } = await newDoc()
  const page = doc.addPage([PAGE_W, PAGE_H])
  const p = new Painter(page, regular, bold)

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
  const page = doc.addPage([PAGE_W, PAGE_H])
  const p = new Painter(page, regular, bold)

  const dateStr = draft.c4cPlannedStart ? formatLocalDate(timeZone, new Date(draft.c4cPlannedStart)) : ''

  p.title('Gespraechsprotokoll')
  p.blank()
  p.line(`Konto: ${draft.c4cAccountName ?? ''}`)
  p.line(`Datum: ${dateStr}`)
  p.blank()

  for (const entry of (entries ?? [])) {
    const role = entry.role === 'user' ? 'Nutzer' : 'Assistent'
    p.line(`[${role}]`)
    p.wrapped(entry.text ?? '', 10)
    p.blank()
  }

  return doc.save()
}
