import { describe, expect, it } from 'vitest'
import { buildCreditLines, draftsFromLines, emptyCreditDraft, type InvoiceLineInfo } from '@/modules/sales/creditLines'
import type { Creditable } from '@/services/creditNotes'

const creditable = (over: Partial<Creditable> = {}): Creditable => ({
  invoice_line_id: 'l1', line_no: 1, quantity: 10, returned_quantity: 0, remaining_quantity: 10, line_net: 100, credited_net: 0, remaining_net: 100,
  line_tax: 20, credited_tax: 0, remaining_tax: 20, ...over,
})
const info = (over: Partial<InvoiceLineInfo> = {}, c: Partial<Creditable> = {}): InvoiceLineInfo => ({
  id: 'l1', lineNo: 1, label: 'Panadol', unitPrice: 10, discountPercent: 0, taxRate: 20, creditable: creditable(c), ...over,
})
const draft = (over: object) => ({ ...emptyCreditDraft('l1'), ...over })
const rights = { canRestock: false }

describe('buildCreditLines', () => {
  it('needs something to credit', () => {
    expect(buildCreditLines([emptyCreditDraft('l1')], [info()], rights)).toMatchObject({ ok: false })
  })

  it('values a partial return at the price charged with tax at the line rate', () => {
    const r = buildCreditLines([draft({ returnQty: '4' })], [info()], rights)
    expect(r).toMatchObject({ ok: true, subtotal: 40, tax: 8, total: 48, perLine: { l1: 48 } })
    if (r.ok) expect(r.lines).toEqual([{ type: 'RETURN', invoice_line_id: 'l1', quantity: 4, condition: 'QUARANTINE' }])
  })

  it('credits exactly what is left when the last of a line comes back (no cents lost)', () => {
    const r = buildCreditLines([draft({ returnQty: '3' })], [info({ unitPrice: 33.333 }, { quantity: 3, remaining_quantity: 3, remaining_net: 100, remaining_tax: 20 })], rights)
    expect(r).toMatchObject({ ok: true, subtotal: 100, tax: 20, total: 120 })
  })

  it('applies the discount that was given, and caps a return at the value left', () => {
    const r = buildCreditLines([draft({ returnQty: '2' })], [info({ discountPercent: 10 })], rights)
    expect(r).toMatchObject({ ok: true, subtotal: 18 })
    const capped = buildCreditLines([draft({ returnQty: '5' })], [info({}, { remaining_quantity: 10, remaining_net: 30, remaining_tax: 6 })], rights)
    expect(capped).toMatchObject({ ok: true, subtotal: 30, tax: 6 })
  })

  it('refuses more than can still be returned, bad quantities and unauthorised restocking', () => {
    expect(buildCreditLines([draft({ returnQty: '11' })], [info()], rights)).toMatchObject({ ok: false, error: expect.stringContaining('only 10') })
    expect(buildCreditLines([draft({ returnQty: '0' })], [info()], rights)).toMatchObject({ ok: false })
    expect(buildCreditLines([draft({ returnQty: '1.0001' })], [info()], rights)).toMatchObject({ ok: false })
    expect(buildCreditLines([draft({ returnQty: '1', condition: 'AVAILABLE' })], [info()], rights)).toMatchObject({ ok: false, error: expect.stringContaining('sellable stock') })
    expect(buildCreditLines([draft({ returnQty: '1', condition: 'AVAILABLE' })], [info()], { canRestock: true })).toMatchObject({ ok: true })
  })

  it('takes a price correction after any return on the same line and carries proportional tax', () => {
    const r = buildCreditLines([draft({ priceAmount: '25', priceNote: ' Rebate ' })], [info()], rights)
    expect(r).toMatchObject({ ok: true, subtotal: 25, tax: 5, total: 30 })
    if (r.ok) expect(r.lines).toEqual([{ type: 'PRICE', invoice_line_id: 'l1', amount: 25, description: 'Rebate' }])
    const both = buildCreditLines([draft({ returnQty: '10', priceAmount: '1' })], [info()], rights)
    expect(both).toMatchObject({ ok: false, error: expect.stringContaining('only 0') })            // the return already takes the whole line
    expect(buildCreditLines([draft({ priceAmount: '100.01' })], [info()], rights)).toMatchObject({ ok: false })
    expect(buildCreditLines([draft({ priceAmount: '1.005' })], [info()], rights)).toMatchObject({ ok: false })
    expect(buildCreditLines([draft({ priceAmount: '100' })], [info()], rights)).toMatchObject({ ok: true, tax: 20, total: 120 })
  })
})

describe('draftsFromLines', () => {
  it('rebuilds the form rows from a saved draft', () => {
    const infos = [info(), info({ id: 'l2', lineNo: 2 })]
    const rows = draftsFromLines([
      { line_type: 'RETURN', invoice_line_id: 'l1', quantity: 2.5, return_condition: 'DAMAGED', batch_id: 'b1', description: null, line_net: 25 },
      { line_type: 'PRICE', invoice_line_id: 'l2', quantity: null, return_condition: null, batch_id: null, description: 'Rebate', line_net: 7 },
    ], infos)
    expect(rows).toEqual([
      { invoiceLineId: 'l1', returnQty: '2.5', condition: 'DAMAGED', batchId: 'b1', priceAmount: '', priceNote: '' },
      { invoiceLineId: 'l2', returnQty: '', condition: 'QUARANTINE', batchId: '', priceAmount: '7', priceNote: 'Rebate' },
    ])
  })
})
