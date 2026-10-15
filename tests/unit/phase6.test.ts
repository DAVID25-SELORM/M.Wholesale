import { describe, expect, it } from 'vitest'
import { buildSalesLines, effectivePrice, emptySalesLine, type SalesLineDraft } from '@/modules/sales/invoiceLines'
import type { ProductRow } from '@/services/catalog'
import { licenceDaysLeft } from '@/services/customers'
import { computeLine, moneyFmt, round2 } from '@/services/sales'

const product = (id: string): ProductRow => ({
  id, sku: id.toUpperCase(), brand_name: id, generic_name: null, strength_text: null, dosage_form: null, manufacturer_name: null, product_class: 'OTC', is_active: true,
})
const line = (over: Partial<SalesLineDraft>): SalesLineDraft => ({ ...emptySalesLine('k'), product: product('p1'), quantity: '1', listPrice: 10, ...over })
const full = { canOverridePrice: true, canDiscount: true }
const none = { canOverridePrice: false, canDiscount: false }

describe('round2 / computeLine (mirror of the database arithmetic)', () => {
  it('rounds half away from zero and ignores binary noise', () => {
    expect(round2(1.005)).toBe(1.01)
    expect(round2(2.675)).toBe(2.68)
    expect(round2(-1.005)).toBe(-1.01)
    expect(round2(0.1 + 0.2)).toBe(0.3)
  })
  it('computes net, tax and total per line', () => {
    expect(computeLine(3, 95, 0, 0)).toEqual({ gross: 285, net: 285, discount: 0, tax: 0, total: 285 })
    const c = computeLine(10, 9.99, 10, 15)
    expect(c.gross).toBe(99.9)
    expect(c.net).toBe(89.91)
    expect(c.discount).toBe(9.99)
    expect(c.tax).toBe(13.49)
    expect(c.total).toBe(103.4)
  })
  it('formats money with two decimals and treats a missing value as 0', () => {
    expect(moneyFmt(1234.5)).toMatch(/1.234\.50|1,234\.50|1 234,50/)
    expect(moneyFmt(null)).toMatch(/0[.,]00/)
  })
})

describe('buildSalesLines', () => {
  it('needs at least one line, a product and a positive quantity', () => {
    expect(buildSalesLines([], full)).toMatchObject({ ok: false })
    expect(buildSalesLines([line({ product: null })], full)).toMatchObject({ ok: false, error: expect.stringContaining('Line 1') })
    expect(buildSalesLines([line({ quantity: '0' })], full)).toMatchObject({ ok: false })
    expect(buildSalesLines([line({ quantity: '1.0005' })], full)).toMatchObject({ ok: false })
  })
  it('uses the list price unless one is typed, and only sends a price that was named', () => {
    const r = buildSalesLines([line({ quantity: '2' })], none)
    expect(r).toMatchObject({ ok: true, subtotal: 20, total: 20 })
    if (r.ok) expect(r.lines[0]).not.toHaveProperty('unit_price')
    const o = buildSalesLines([line({ quantity: '2', price: '8' })], full)
    if (o.ok) expect(o.lines[0]).toMatchObject({ unit_price: 8 })
    expect(effectivePrice(line({ price: '' }))).toBe(10)
    expect(effectivePrice(line({ price: 'abc' }))).toBeNull()
  })
  it('refuses a missing list price unless a price is typed', () => {
    expect(buildSalesLines([line({ listPrice: null })], none)).toMatchObject({ ok: false, error: expect.stringContaining('no price') })
    expect(buildSalesLines([line({ listPrice: null, price: '5' })], full)).toMatchObject({ ok: true })
  })
  it('enforces the price-override and discount rights', () => {
    expect(buildSalesLines([line({ price: '7' })], none)).toMatchObject({ ok: false, error: expect.stringContaining('price list') })
    expect(buildSalesLines([line({ discount: '5' })], none)).toMatchObject({ ok: false, error: expect.stringContaining('discounts') })
    expect(buildSalesLines([line({ price: '10' })], none)).toMatchObject({ ok: true })              // typing the list price is not an override
    expect(buildSalesLines([line({ discount: '101' })], full)).toMatchObject({ ok: false })
  })
  it('totals discounts and tax line by line', () => {
    const r = buildSalesLines([line({ quantity: '10', listPrice: 9.99, discount: '10', taxRate: 15 }), line({ product: product('p2'), quantity: '1', listPrice: 5 })], full)
    expect(r).toMatchObject({ ok: true, subtotal: 94.91, discount: 9.99, tax: 13.49, total: 108.4 })
  })
  it('rejects the same product, pack, price and discount twice', () => {
    expect(buildSalesLines([line({}), line({})], full)).toMatchObject({ ok: false, error: expect.stringContaining('Line 2') })
    expect(buildSalesLines([line({}), line({ unitId: 'box', factor: 14 })], full)).toMatchObject({ ok: true })
  })
})

describe('licenceDaysLeft', () => {
  const today = new Date(2026, 9, 15)
  it('counts days to expiry, negative once expired, null when not recorded', () => {
    expect(licenceDaysLeft('2026-10-15', today)).toBe(0)
    expect(licenceDaysLeft('2026-11-14', today)).toBe(30)
    expect(licenceDaysLeft('2026-10-14', today)).toBe(-1)
    expect(licenceDaysLeft(null, today)).toBeNull()
  })
})
