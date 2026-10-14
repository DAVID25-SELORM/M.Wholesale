import { describe, expect, it } from 'vitest'
import { buildInvoiceLines, previewMatch, type InvoiceLineDraft } from '@/modules/purchasing/invoiceLines'
import { buildPostLines, emptyLine } from '@/modules/inventory/postLines'
import { INVOICE_STATUSES, INVOICE_STATUS_LABEL, INVOICE_STATUS_TONE, MATCH_LABEL } from '@/services/payables'
import { COUNT_STATUSES, COUNT_STATUS_LABEL, COUNT_STATUS_TONE, lineVariance } from '@/services/stockCounts'
import { RETURN_REASONS, RETURN_REASON_LABEL } from '@/services/purchasing'

const draft = (o: Partial<InvoiceLineDraft> = {}): InvoiceLineDraft => ({ poLineId: 'l1', include: true, quantity: '6', price: '100', poPrice: 100, allowed: 6, ...o })
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error)

describe('buildInvoiceLines', () => {
  it('needs at least one ticked line with a quantity and a price', () => {
    expect(err(buildInvoiceLines([]))).toMatch(/at least one line/)
    expect(err(buildInvoiceLines([draft({ include: false })]))).toMatch(/at least one line/)
    expect(err(buildInvoiceLines([draft({ quantity: '' })], { l1: 'Augmentin' }))).toMatch(/Augmentin: .*quantity/)
    expect(err(buildInvoiceLines([draft({ quantity: '0' })]))).toMatch(/quantity/)
    expect(err(buildInvoiceLines([draft({ price: '-1' })]))).toMatch(/price/)
    expect(err(buildInvoiceLines([draft({ quantity: '1.0001' })]))).toMatch(/3 decimals/)
    expect(err(buildInvoiceLines([draft({ price: '1.00001' })]))).toMatch(/4 decimals/)
  })
  it('shapes the lines and totals them to the cent, ignoring unticked lines', () => {
    const r = buildInvoiceLines([draft({ quantity: '3', price: '33.333' }), draft({ poLineId: 'l2', include: false }), draft({ poLineId: 'l3', quantity: '2', price: '10.5' })])
    expect(r).toEqual({ ok: true, subtotal: 121, lines: [{ po_line_id: 'l1', quantity: 3, unit_price: 33.333 }, { po_line_id: 'l3', quantity: 2, unit_price: 10.5 }] })
  })
})

describe('previewMatch (mirrors the database rule)', () => {
  it('matches within what can be billed and within 1 % of the order price', () => {
    expect(previewMatch(draft())).toBe('MATCHED')
    expect(previewMatch(draft({ price: '100.9' }))).toBe('MATCHED')
    expect(previewMatch(draft({ quantity: '7' }))).toBe('QTY_OVER')
    expect(previewMatch(draft({ price: '101.5' }))).toBe('PRICE_DIFF')
    expect(previewMatch(draft({ quantity: '7', price: '90' }))).toBe('QTY_AND_PRICE')
  })
  it('treats a zero-priced order line strictly', () => {
    expect(previewMatch(draft({ poPrice: 0, price: '0' }))).toBe('MATCHED')
    expect(previewMatch(draft({ poPrice: 0, price: '0.5' }))).toBe('PRICE_DIFF')
  })
})

describe('incoming cost on stock lines', () => {
  const product = { id: 'p1', sku: 'S', brand_name: 'B', generic_name: null, strength_text: null, dosage_form: null, manufacturer_name: null, product_class: 'POM', is_active: true }
  const base = { ...emptyLine('k'), product, quantity: '2', batchNumber: 'AB', expiry: '2030-01-01' }
  it('passes an optional cost per pack and rejects a negative one', () => {
    expect(buildPostLines('OPENING', [{ ...base, cost: '12.5' }])).toMatchObject({ ok: true, lines: [{ unit_cost: 12.5 }] })
    const none = buildPostLines('OPENING', [base])
    expect(none.ok && 'unit_cost' in none.lines[0]!).toBe(false)
    expect(buildPostLines('OPENING', [{ ...base, cost: '-1' }])).toMatchObject({ ok: false })
  })
})

describe('labels and variance', () => {
  it('labels every status and reason', () => {
    for (const s of INVOICE_STATUSES) { expect(INVOICE_STATUS_LABEL[s]).toBeTruthy(); expect(INVOICE_STATUS_TONE[s]).toBeTruthy() }
    for (const s of COUNT_STATUSES) { expect(COUNT_STATUS_LABEL[s]).toBeTruthy(); expect(COUNT_STATUS_TONE[s]).toBeTruthy() }
    for (const r of RETURN_REASONS) expect(RETURN_REASON_LABEL[r]).toBeTruthy()
    expect(Object.keys(MATCH_LABEL)).toHaveLength(4)
  })
  it('computes a count line difference, or nothing while uncounted', () => {
    expect(lineVariance({ system_quantity: 100, counted_quantity: null })).toBeNull()
    expect(lineVariance({ system_quantity: 100, counted_quantity: 97 })).toBe(-3)
    expect(lineVariance({ system_quantity: 10.1, counted_quantity: 10.35 })).toBe(0.25)
  })
})
