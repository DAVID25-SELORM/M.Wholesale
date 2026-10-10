import { describe, expect, it } from 'vitest'
import { buildOrderLines, buildReceiveLines, emptyOrderLine, emptyPart, type OrderLineDraft, type ReceivePart } from '@/modules/purchasing/orderLines'
import { PO_STATUSES, PO_STATUS_LABEL, PO_STATUS_TONE, money, remainingPacks, type PurchaseOrderLine } from '@/services/purchasing'

const product = { id: 'p1', sku: 'AUG', brand_name: 'Augmentin', generic_name: null, strength_text: null, dosage_form: null, manufacturer_name: null, product_class: 'POM', is_active: true }
const draft = (o: Partial<OrderLineDraft> = {}): OrderLineDraft => ({ ...emptyOrderLine('k'), product, quantity: '10', cost: '85.5', unitId: 'box', ...o })
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error)

describe('buildOrderLines', () => {
  it('needs lines, a product, a positive quantity and a cost', () => {
    expect(err(buildOrderLines([]))).toMatch(/at least one/)
    expect(err(buildOrderLines([draft({ product: null })]))).toMatch(/Line 1: choose a product/)
    for (const quantity of ['', '0', '-1', 'x']) expect(err(buildOrderLines([draft({ quantity })]))).toMatch(/quantity/)
    for (const cost of ['', '-1', 'x']) expect(err(buildOrderLines([draft({ cost })]))).toMatch(/cost/)
    expect(err(buildOrderLines([draft({ quantity: '1.0001' })]))).toMatch(/3 decimals/)
    expect(err(buildOrderLines([draft({ cost: '1.00001' })]))).toMatch(/4 decimals/)
  })

  it('shapes the lines and totals them to the cent', () => {
    const r = buildOrderLines([draft(), draft({ key: 'b', product: { ...product, id: 'p2' }, unitId: '', quantity: '3', cost: '0.335' })])
    expect(r).toEqual({
      ok: true, total: 856.01,
      lines: [{ product_id: 'p1', quantity: 10, unit_cost: 85.5, product_unit_id: 'box' }, { product_id: 'p2', quantity: 3, unit_cost: 0.335 }],
    })
  })

  it('refuses the same product and pack level twice, but allows different pack levels', () => {
    expect(err(buildOrderLines([draft(), draft({ key: 'b' })]))).toMatch(/Line 2: .*already on the order/)
    expect(buildOrderLines([draft(), draft({ key: 'b', unitId: 'carton' })]).ok).toBe(true)
  })
})

const line = (o: Partial<PurchaseOrderLine> = {}): PurchaseOrderLine => ({
  id: 'l1', organization_id: 'o', purchase_order_id: 'po', branch_id: 'b', line_no: 1, product_id: 'p1', product_unit_id: 'box',
  quantity_ordered: 10, unit_cost: 85.5, ordered_base: 140, received_base: 0, line_total: 855,
  product: { sku: 'AUG', brand_name: 'Augmentin', track_batches: true }, unit: { factor_to_base: 14, unit: { code: 'BOX', name: 'Box' } }, ...o,
} as PurchaseOrderLine)
const part = (o: Partial<ReceivePart> = {}): ReceivePart => ({ ...emptyPart('k', { id: 'l1', product_unit_id: 'box', factor: 14 }), quantity: '4', batch: 'AB1', expiry: '2030-01-01', ...o })

describe('buildReceiveLines', () => {
  it('ignores blank parts and needs at least one quantity', () => {
    expect(err(buildReceiveLines([part({ quantity: '' })], [line()]))).toMatch(/at least one/)
    const r = buildReceiveLines([part(), part({ key: 'b', quantity: '  ' })], [line()])
    expect(r).toEqual({ ok: true, lines: [{ po_line_id: 'l1', quantity: 4, product_unit_id: 'box', status: 'AVAILABLE', batch_number: 'AB1', expiry_date: '2030-01-01' }] })
  })

  it('needs batch and expiry for tracked products only', () => {
    expect(err(buildReceiveLines([part({ batch: '' })], [line()]))).toMatch(/batch number/)
    expect(err(buildReceiveLines([part({ expiry: '' })], [line()]))).toMatch(/expiry/)
    expect(err(buildReceiveLines([part({ mfg: '2031-01-01' })], [line()]))).toMatch(/manufacture/)
    const untracked = line({ product: { sku: 'G', brand_name: 'Gloves', track_batches: false } })
    expect(buildReceiveLines([part({ batch: '', expiry: '' })], [untracked])).toEqual({
      ok: true, lines: [{ po_line_id: 'l1', quantity: 4, product_unit_id: 'box', status: 'AVAILABLE' }],
    })
  })

  it('never lets more than the remaining quantity be received, across parts and earlier receipts', () => {
    const l = line({ received_base: 56 })                              // 84 base units (6 boxes) still expected
    expect(buildReceiveLines([part({ quantity: '6' })], [l]).ok).toBe(true)
    expect(err(buildReceiveLines([part({ quantity: '7' })], [l]))).toMatch(/only 84/)
    expect(err(buildReceiveLines([part({ quantity: '4' }), part({ key: 'b', quantity: '3', batch: 'AB2' })], [l]))).toMatch(/cannot receive more/)
    // receiving loose tablets of a box-ordered line is converted
    expect(buildReceiveLines([part({ quantity: '84', unitId: 'tablet', factor: 1 })], [l]).ok).toBe(true)
    expect(err(buildReceiveLines([part({ quantity: '85', unitId: 'tablet', factor: 1 })], [l]))).toMatch(/only 84/)
  })

  it('carries status and location', () => {
    const r = buildReceiveLines([part({ status: 'QUARANTINE', locationId: 'loc' })], [line()])
    expect(r.ok && r.lines[0]).toMatchObject({ status: 'QUARANTINE', location_id: 'loc' })
  })
})

describe('purchasing helpers', () => {
  it('computes what is still expected in packs', () => {
    expect(remainingPacks(line())).toBe(10)
    expect(remainingPacks(line({ received_base: 56 }))).toBe(6)
    expect(remainingPacks(line({ received_base: 140 }))).toBe(0)
  })
  it('labels every status and formats money', () => {
    for (const s of PO_STATUSES) { expect(PO_STATUS_LABEL[s]).toBeTruthy(); expect(PO_STATUS_TONE[s]).toBeTruthy() }
    expect(money(1234.5, 'GHS')).toMatch(/^GHS 1.234.50$|^GHS 1,234\.50$|^GHS 1.234,50$/)
  })
})
