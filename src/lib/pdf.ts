import { saveBlob } from './download'

// PDFs are produced in the browser from data already on screen. jsPDF is loaded only when someone clicks "Download PDF".

export interface PdfColumn { header: string; align?: 'left' | 'right' | 'center'; width?: number }

export interface TablePdfSpec {
  title: string
  subtitle?: string
  /** the organisation printed top left */
  organization?: string
  columns: PdfColumn[]
  rows: string[][]
  /** bold rows after the body (totals) */
  footer?: string[][]
  landscape?: boolean
  filename: string
}

export interface DocumentPdfSpec {
  /** "TAX INVOICE", "CREDIT NOTE", "QUOTATION" ... */
  kind: string
  number: string
  organization: { name: string; lines: string[] }
  /** small right-hand details: date, due date, reference ... */
  meta: [string, string][]
  /** the other party (bill to / credit to / prepared for) */
  party: { heading: string; name: string; lines: string[] }
  columns: PdfColumn[]
  rows: string[][]
  /** label / amount pairs under the table; the last one is drawn bold */
  totals: [string, string][]
  notes?: string[]
  /** a diagonal banner such as REVERSED or CANCELLED */
  stamp?: string
  filename: string
}

const BRAND: [number, number, number] = [15, 118, 110]
const GREY: [number, number, number] = [100, 116, 139]

type Doc = import('jspdf').jsPDF

async function load() {
  const [{ jsPDF }, autoTableModule] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  return { jsPDF, autoTable: autoTableModule.default }
}

const colStyles = (columns: PdfColumn[]) =>
  Object.fromEntries(columns.map((c, i) => [i, { halign: c.align ?? 'left', ...(c.width ? { cellWidth: c.width } : {}) }]))

function footer(doc: Doc, text: string) {
  const pages = doc.getNumberOfPages()
  const w = doc.internal.pageSize.getWidth()
  const h = doc.internal.pageSize.getHeight()
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i)
    doc.setFontSize(8)
    doc.setTextColor(...GREY)
    doc.text(text, 14, h - 8)
    doc.text(`Page ${i} of ${pages}`, w - 14, h - 8, { align: 'right' })
  }
}

/** A report: title, optional subtitle, one table with optional bold total rows. */
export async function downloadTablePdf(spec: TablePdfSpec): Promise<void> {
  const { jsPDF, autoTable } = await load()
  const doc = new jsPDF({ orientation: spec.landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' })
  doc.setFontSize(9)
  doc.setTextColor(...GREY)
  if (spec.organization) doc.text(spec.organization, 14, 12)
  doc.setFontSize(16)
  doc.setTextColor(15, 23, 42)
  doc.text(spec.title, 14, 20)
  let y = 24
  if (spec.subtitle) {
    doc.setFontSize(9)
    doc.setTextColor(...GREY)
    doc.text(spec.subtitle, 14, y + 2)
    y += 6
  }
  autoTable(doc, {
    startY: y + 2,
    head: [spec.columns.map((c) => c.header)],
    body: spec.rows,
    foot: spec.footer,
    styles: { fontSize: 8, cellPadding: 1.6 },
    headStyles: { fillColor: BRAND, textColor: 255 },
    footStyles: { fillColor: [241, 245, 249], textColor: [15, 23, 42], fontStyle: 'bold' },
    columnStyles: colStyles(spec.columns),
    showFoot: 'lastPage',
  })
  footer(doc, `${spec.title} · generated ${new Date().toLocaleString()}`)
  saveBlob(doc.output('blob'), spec.filename.endsWith('.pdf') ? spec.filename : `${spec.filename}.pdf`)
}

/** An invoice-style document: header, the other party, one table, totals, notes. */
export async function downloadDocumentPdf(spec: DocumentPdfSpec): Promise<void> {
  const { jsPDF, autoTable } = await load()
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const w = doc.internal.pageSize.getWidth()
  doc.setTextColor(15, 23, 42)
  doc.setFontSize(14)
  doc.text(spec.organization.name, 14, 18)
  doc.setFontSize(9)
  doc.setTextColor(...GREY)
  spec.organization.lines.filter(Boolean).forEach((l, i) => doc.text(l, 14, 24 + i * 4.5))
  doc.setFontSize(18)
  doc.setTextColor(...BRAND)
  doc.text(spec.kind, w - 14, 18, { align: 'right' })
  doc.setFontSize(10)
  doc.setTextColor(15, 23, 42)
  doc.text(spec.number, w - 14, 24, { align: 'right' })
  doc.setFontSize(9)
  doc.setTextColor(...GREY)
  spec.meta.forEach(([k, v], i) => doc.text(`${k}: ${v}`, w - 14, 29.5 + i * 4.5, { align: 'right' }))

  const topParty = 24 + Math.max(spec.organization.lines.filter(Boolean).length, spec.meta.length) * 4.5 + 8
  doc.setFontSize(8)
  doc.text(spec.party.heading.toUpperCase(), 14, topParty)
  doc.setFontSize(11)
  doc.setTextColor(15, 23, 42)
  doc.text(spec.party.name, 14, topParty + 5)
  doc.setFontSize(9)
  doc.setTextColor(...GREY)
  spec.party.lines.filter(Boolean).forEach((l, i) => doc.text(l, 14, topParty + 10 + i * 4.5))

  const start = topParty + 12 + spec.party.lines.filter(Boolean).length * 4.5
  autoTable(doc, {
    startY: start,
    head: [spec.columns.map((c) => c.header)],
    body: spec.rows,
    styles: { fontSize: 8.5, cellPadding: 2 },
    headStyles: { fillColor: BRAND, textColor: 255 },
    columnStyles: colStyles(spec.columns),
  })
  const table = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable
  let y = (table?.finalY ?? start) + 8
  if (y > doc.internal.pageSize.getHeight() - 50) { doc.addPage(); y = 20 }
  spec.totals.forEach(([k, v], i) => {
    const last = i === spec.totals.length - 1
    doc.setFontSize(last ? 11 : 9)
    doc.setFont('helvetica', last ? 'bold' : 'normal')
    doc.setTextColor(last ? 15 : 100, last ? 23 : 116, last ? 42 : 139)
    doc.text(k, w - 60, y)
    doc.text(v, w - 14, y, { align: 'right' })
    y += last ? 7 : 5
  })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...GREY)
  y += 4
  for (const n of spec.notes ?? []) {
    const wrapped = doc.splitTextToSize(n, w - 28) as string[]
    if (y + wrapped.length * 4.5 > doc.internal.pageSize.getHeight() - 14) { doc.addPage(); y = 20 }
    doc.text(wrapped, 14, y)
    y += wrapped.length * 4.5 + 2
  }
  if (spec.stamp) {
    for (let i = 1; i <= doc.getNumberOfPages(); i++) {
      doc.setPage(i)
      doc.setFontSize(54)
      doc.setTextColor(220, 38, 38)
      doc.text(spec.stamp, w / 2, doc.internal.pageSize.getHeight() / 2, { align: 'center', angle: 30 })
    }
  }
  footer(doc, `${spec.kind} ${spec.number}`)
  saveBlob(doc.output('blob'), spec.filename.endsWith('.pdf') ? spec.filename : `${spec.filename}.pdf`)
}
