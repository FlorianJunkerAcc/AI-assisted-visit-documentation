// The transcript PDF must contain the whole conversation (regression: only one page was created).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument } from 'pdf-lib'
import { generateSummaryPdf, generateTranscriptPdf } from '../srv/lib/pdf-generator.js'

const draft = { c4cAccountName: 'ACME', c4cSubject: 'Test', c4cPlannedStart: '2026-11-26T09:00:00Z' }
const pageCount = async (bytes) => (await PDFDocument.load(bytes)).getPageCount()

describe('PDF generator – page breaks', () => {
  it('a long transcript spans several pages', async () => {
    const entries = Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 ? 'user' : 'assistant',
      text: `Beitrag ${i}: ` + 'Wir haben ausführlich über das Angebot gesprochen. '.repeat(4)
    }))
    const pages = await pageCount(await generateTranscriptPdf(draft, entries, 'Europe/Berlin'))
    assert.ok(pages >= 4, `expected several pages, got ${pages}`)
  })

  it('a long summary spans several pages', async () => {
    const long = { ...draft, proposedSummary: 'Ergebnis und Vereinbarung.\n'.repeat(200) }
    assert.ok(await pageCount(await generateSummaryPdf(long, [], 'Europe/Berlin')) >= 2)
  })

  it('characters outside WinAnsi and very long words do not break the PDF', async () => {
    const entries = [{ role: 'user', text: 'Smiley 😀, Pfeil →, 漢字\r\n\tx ' + 'a'.repeat(500) }]
    assert.equal(await pageCount(await generateTranscriptPdf(draft, entries, 'Europe/Berlin')), 1)
  })
})
