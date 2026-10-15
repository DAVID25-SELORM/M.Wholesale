import { beforeEach, describe, expect, it, vi } from 'vitest'

const saved: { blob: Blob; name: string }[] = []
vi.mock('@/lib/download', () => ({ saveBlob: (blob: Blob, name: string) => { saved.push({ blob, name }) } }))

import { downloadDocumentPdf, downloadTablePdf } from '@/lib/pdf'

const header = async (b: Blob) => new TextDecoder().decode(new Uint8Array(await b.arrayBuffer()).slice(0, 5))

describe('PDF generation', () => {
  beforeEach(() => { saved.length = 0 })

  it('builds an invoice-style document that is a real PDF, named as asked', async () => {
    await downloadDocumentPdf({
      kind: 'TAX INVOICE', number: 'INV-2026-000001', organization: { name: 'Demo Wholesale Pharma Ltd', lines: ['Accra', '030 000 000', ''] },
      meta: [['Date', '2026-10-15'], ['Due', '2026-11-14']], party: { heading: 'Bill to', name: 'Adom Pharmacy', lines: ['Accra', 'Licence PC/1'] },
      columns: [{ header: 'Item' }, { header: 'Qty', align: 'right' }, { header: 'Amount', align: 'right' }],
      rows: Array.from({ length: 60 }, (_, i) => [`Product ${i} (SKU-${i})`, '10 Tablet', '12.50']),
      totals: [['Subtotal', '750.00'], ['Total (GHS)', '750.00'], ['Balance due', '750.00']], notes: ['Thank you for your business. '.repeat(20)], stamp: 'REVERSED', filename: 'invoice-INV-2026-000001',
    })
    expect(saved).toHaveLength(1)
    expect(saved[0]!.name).toBe('invoice-INV-2026-000001.pdf')
    expect(await header(saved[0]!.blob)).toBe('%PDF-')
    expect(saved[0]!.blob.size).toBeGreaterThan(5_000)             // 60 lines span several pages
  })

  it('builds a landscape table report with totals', async () => {
    await downloadTablePdf({
      title: 'Sales by day', subtitle: '2026-10-01 to 2026-10-15', organization: 'Demo', landscape: true, filename: 'sales-by-day.pdf',
      columns: [{ header: 'Day' }, { header: 'Net sales', align: 'right' }], rows: [['15 Oct 2026', '556.00']], footer: [['Total', '556.00']],
    })
    expect(saved[0]!.name).toBe('sales-by-day.pdf')
    expect(await header(saved[0]!.blob)).toBe('%PDF-')
  })
})
