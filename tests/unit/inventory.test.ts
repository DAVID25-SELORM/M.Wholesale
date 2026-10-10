import { describe, expect, it } from 'vitest'
import { buildPostLines, emptyLine, takesFromStock, type LineDraft } from '@/modules/inventory/postLines'
import { daysUntil, expiryLabel, expiryTone, type BalanceRow } from '@/services/inventory'

const product = { id: 'p1', sku: 'AUG', brand_name: 'Augmentin', generic_name: null, strength_text: null, dosage_form: null, manufacturer_name: null, product_class: 'POM', is_active: true }
const balance = (o: Partial<BalanceRow> = {}): BalanceRow => ({
  id: 'b1', warehouse_id: 'w1', location_id: null, product_id: 'p1', batch_id: 'bt1', stock_status: 'AVAILABLE', quantity: 28,
  warehouse: { code: 'W1', name: 'Main' }, location: null, batch: { batch_number: 'AB1', expiry_date: '2030-01-01' }, ...o,
})
const draft = (o: Partial<LineDraft> = {}): LineDraft => ({ ...emptyLine('k'), product, quantity: '5', ...o })
const err = (r: ReturnType<typeof buildPostLines>) => (r.ok ? null : r.error)

describe('buildPostLines', () => {
  it('requires at least one line, a product and a positive quantity', () => {
    expect(err(buildPostLines('OPENING', []))).toMatch(/at least one/i)
    expect(err(buildPostLines('OPENING', [draft({ product: null })]))).toMatch(/Line 1: choose a product/)
    for (const quantity of ['', '0', '-2', 'abc']) {
      expect(err(buildPostLines('OPENING', [draft({ quantity, batchNumber: 'X', expiry: '2030-01-01' })]))).toMatch(/quantity/)
    }
  })

  it('shapes opening stock with a new batch, location and status', () => {
    const r = buildPostLines('OPENING', [draft({ batchNumber: ' AB-1 ', expiry: '2030-05-01', mfg: '2028-05-01', locationId: 'loc', status: 'QUARANTINE', unitId: 'box', factor: 14 })])
    expect(r).toEqual({
      ok: true,
      lines: [{ product_id: 'p1', quantity: 5, product_unit_id: 'box', batch_number: 'AB-1', expiry_date: '2030-05-01', manufacture_date: '2028-05-01', location_id: 'loc', status: 'QUARANTINE' }],
    })
  })

  it('needs batch and expiry for tracked products only, and sanity-checks dates', () => {
    expect(err(buildPostLines('OPENING', [draft()]))).toMatch(/batch number/)
    expect(err(buildPostLines('OPENING', [draft({ batchNumber: 'X' })]))).toMatch(/expiry/)
    expect(err(buildPostLines('OPENING', [draft({ batchNumber: 'X', expiry: '2030-01-01', mfg: '2031-01-01' })]))).toMatch(/manufacture/)
    const untracked = buildPostLines('OPENING', [draft({ tracks: false })])
    expect(untracked).toEqual({ ok: true, lines: [{ product_id: 'p1', quantity: 5, status: 'AVAILABLE' }] })
  })

  it('adjustment OUT takes from a chosen balance and cannot exceed it, even across lines', () => {
    const out = (o: Partial<LineDraft>) => draft({ direction: 'OUT', balance: balance(), ...o })
    expect(buildPostLines('ADJUSTMENT', [out({ quantity: '3' })])).toEqual({
      ok: true, lines: [{ product_id: 'p1', quantity: 3, batch_id: 'bt1', status: 'AVAILABLE', direction: 'OUT' }],
    })
    expect(err(buildPostLines('ADJUSTMENT', [out({ quantity: '29' })]))).toMatch(/only 28 available/)
    expect(err(buildPostLines('ADJUSTMENT', [out({ quantity: '20' }), out({ key: 'k2', quantity: '9' })]))).toMatch(/Line 2: only 28 available/)
    expect(err(buildPostLines('ADJUSTMENT', [out({ balance: null })]))).toMatch(/choose which stock/)
  })

  it('converts pack quantities before comparing with what is on hand', () => {
    const box = { unitId: 'box', factor: 14 }
    expect(buildPostLines('TRANSFER', [draft({ ...box, quantity: '2', balance: balance() })]).ok).toBe(true)  // 28
    expect(err(buildPostLines('TRANSFER', [draft({ ...box, quantity: '3', balance: balance() })]))).toMatch(/only 28 available/)
    expect(err(buildPostLines('OPENING', [draft({ factor: 3, quantity: '0.3334', batchNumber: 'X', expiry: '2030-01-01' })]))).toMatch(/decimals/)
  })

  it('transfers carry the source status and optional destination location', () => {
    const r = buildPostLines('TRANSFER', [draft({ quantity: '4', balance: balance({ location_id: 'l1', stock_status: 'QUARANTINE' }), toLocationId: 'l9' })])
    expect(r).toEqual({ ok: true, lines: [{ product_id: 'p1', quantity: 4, batch_id: 'bt1', location_id: 'l1', status: 'QUARANTINE', to_location_id: 'l9' }] })
  })

  it('status change needs a real change', () => {
    const same = draft({ balance: balance(), toStatus: 'AVAILABLE' })
    expect(err(buildPostLines('STATUS_CHANGE', [same]))).toMatch(/nothing to change/)
    expect(buildPostLines('STATUS_CHANGE', [draft({ balance: balance(), toStatus: 'QUARANTINE' })])).toEqual({
      ok: true, lines: [{ product_id: 'p1', quantity: 5, batch_id: 'bt1', status: 'AVAILABLE', to_status: 'QUARANTINE' }],
    })
    // same status but a different location is a legitimate move
    expect(buildPostLines('STATUS_CHANGE', [draft({ balance: balance(), toStatus: 'AVAILABLE', toLocationId: 'l2' })]).ok).toBe(true)
  })

  it('knows which lines take stock out', () => {
    expect(takesFromStock('OPENING', { direction: 'IN' })).toBe(false)
    expect(takesFromStock('ADJUSTMENT', { direction: 'IN' })).toBe(false)
    expect(takesFromStock('ADJUSTMENT', { direction: 'OUT' })).toBe(true)
    expect(takesFromStock('TRANSFER', { direction: 'IN' })).toBe(true)
    expect(takesFromStock('STATUS_CHANGE', { direction: 'IN' })).toBe(true)
  })
})

describe('expiry helpers', () => {
  it('counts calendar days from today', () => {
    const today = new Date(2026, 9, 9)
    expect(daysUntil('2026-10-09', today)).toBe(0)
    expect(daysUntil('2026-10-10', today)).toBe(1)
    expect(daysUntil('2026-10-08', today)).toBe(-1)
    expect(daysUntil('2027-10-09', today)).toBe(365)
  })

  it('labels and colours urgency', () => {
    expect(expiryLabel(-3)).toBe('Expired 3 d ago')
    expect(expiryLabel(0)).toBe('Expires today')
    expect(expiryLabel(12)).toBe('12 d left')
    expect(expiryTone(-1)).toBe('red')
    expect(expiryTone(30)).toBe('red')
    expect(expiryTone(31)).toBe('amber')
    expect(expiryTone(90)).toBe('amber')
    expect(expiryTone(91)).toBe('slate')
  })
})
