import { describe, expect, it } from 'vitest'
import { SPECS, matchHeaders, templateCsv, toImportRows, type ImportKind } from '@/modules/imports/specs'

describe('import specs', () => {
  it('has a template and unique column keys and names for every kind', () => {
    for (const kind of Object.keys(SPECS) as ImportKind[]) {
      const spec = SPECS[kind]
      const keys = spec.columns.map((c) => c.key)
      expect(new Set(keys).size, kind).toBe(keys.length)
      expect(keys, kind).toContain(spec.keyColumn)
      const header = templateCsv(spec).split(/\r?\n/)[0]!
      expect(header.split(','), kind).toEqual(keys)
      expect(spec.columns.filter((c) => c.required).length, kind).toBeGreaterThan(1)
    }
  })

  it('recognises the headings people really use for opening balances', () => {
    const m = matchHeaders(['Customer', 'Invoice No', 'Date', 'Due', 'Outstanding', 'Remarks', 'Salesman'], SPECS.opening_receivables)
    expect(m.missing).toEqual([])
    expect([...m.mapping.values()]).toEqual(['customer_code', 'reference', 'invoice_date', 'due_date', 'amount', 'notes'])
    expect(m.unrecognised).toEqual(['Salesman'])
    const rows = toImportRows([['Customer', 'Invoice No', 'Date', 'Outstanding'], ['ADOM', 'INV-1', '2026-09-01', '120.50']], matchHeaders(['Customer', 'Invoice No', 'Date', 'Outstanding'], SPECS.opening_receivables).mapping)
    expect(rows[0]).toEqual({ line: 2, values: { customer_code: 'ADOM', reference: 'INV-1', invoice_date: '2026-09-01', amount: '120.50' } })
  })

  it('reports missing required columns for payables and customers', () => {
    expect(matchHeaders(['Supplier', 'Amount'], SPECS.opening_payables).missing.map((c) => c.key)).toEqual(['reference', 'invoice_date'])
    expect(matchHeaders(['Code'], SPECS.customers).missing.map((c) => c.key)).toEqual(['name'])
  })
})
