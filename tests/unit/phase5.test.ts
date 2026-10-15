import { describe, expect, it } from 'vitest'
import { parseCsv, toCsv } from '@/modules/imports/csv'
import { normaliseDate, planOpeningStock, type StockLookups } from '@/modules/imports/openingStock'
import { cellToString } from '@/modules/imports/parseFile'
import { SPECS, matchHeaders, templateCsv, toImportRows } from '@/modules/imports/specs'
import { buildTransferReceipt, emptyReceivePart } from '@/modules/inventory/transferLines'
import { outstandingBase, type StockTransferLine } from '@/services/transfers'

describe('parseCsv', () => {
  it('reads quoted fields, commas, newlines and doubled quotes inside quotes', () => {
    expect(parseCsv('a,b,c\r\n1,"two, 2","say ""hi"""\r\n"line\nbreak",,x\r\n')).toEqual([
      ['a', 'b', 'c'], ['1', 'two, 2', 'say "hi"'], ['line\nbreak', '', 'x'],
    ])
  })
  it('handles a BOM, LF endings, no trailing newline and skips blank lines', () => {
    expect(parseCsv('﻿a,b\n1,2\n\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']])
  })
  it('detects semicolon and tab delimiters (as Excel writes in some regions)', () => {
    expect(parseCsv('sku;name\nA1;Aspirin, 300 mg')).toEqual([['sku', 'name'], ['A1', 'Aspirin, 300 mg']])
    expect(parseCsv('sku\tname\nA1\tAspirin')).toEqual([['sku', 'name'], ['A1', 'Aspirin']])
  })
  it('round-trips through toCsv', () => {
    const rows = [['a', 'b;c', 'd"e'], ['1', 'x,y', 'line\nbreak']]
    expect(parseCsv(toCsv(rows))).toEqual(rows)
  })
})

describe('cellToString', () => {
  it('turns spreadsheet cells into text', () => {
    expect(cellToString(null)).toBe('')
    expect(cellToString('  hi ')).toBe('hi')
    expect(cellToString(6001087000017)).toBe('6001087000017')
    expect(cellToString(0.25)).toBe('0.25')
    expect(cellToString(true)).toBe('yes')
    expect(cellToString(new Date(Date.UTC(2027, 2, 31)))).toBe('2027-03-31')
    expect(cellToString(new Date('nope'))).toBe('')
  })
})

describe('header matching', () => {
  const spec = SPECS.products
  it('recognises our names, labels and common aliases, ignoring case and punctuation', () => {
    const m = matchHeaders(['SKU', 'Product Name', 'Base unit', 'GTIN', 'Generic', 'Form', 'Pack Size', 'Colour'], spec)
    expect([...m.mapping.values()]).toEqual(['sku', 'brand_name', 'base_unit', 'barcode', 'generic_name', 'dosage_form', 'pack_size'])
    expect(m.unrecognised).toEqual(['Colour'])
    expect(m.missing).toEqual([])
  })
  it('reports missing required columns, and ignores a repeated heading', () => {
    const m = matchHeaders(['Name', 'name', 'Barcode'], spec)
    expect(m.missing.map((c) => c.key)).toEqual(['sku', 'base_unit'])
    expect(m.unrecognised).toEqual(['name'])
  })
  it('builds rows with the spreadsheet row number (header is row 1) and drops empty rows', () => {
    const table = [['SKU', 'Name', 'Unit'], ['A1', 'Aspirin', 'TABLET'], ['', '', ''], ['B2', ' Brufen ', 'tablet']]
    const m = matchHeaders(table[0]!, spec)
    expect(toImportRows(table, m.mapping)).toEqual([
      { line: 2, values: { sku: 'A1', brand_name: 'Aspirin', base_unit: 'TABLET' } },
      { line: 4, values: { sku: 'B2', brand_name: 'Brufen', base_unit: 'tablet' } },
    ])
  })
  it('every template matches its own columns exactly', () => {
    for (const spec of Object.values(SPECS)) {
      const table = parseCsv(templateCsv(spec))
      const m = matchHeaders(table[0]!, spec)
      expect(m.missing).toEqual([])
      expect(m.unrecognised).toEqual([])
      expect(m.mapping.size).toBe(spec.columns.length)
      expect(table.length).toBe(3)
    }
  })
})

describe('normaliseDate', () => {
  it('accepts ISO and day-first dates and rejects impossible ones', () => {
    expect(normaliseDate('2028-04-30')).toBe('2028-04-30')
    expect(normaliseDate('30/04/2028')).toBe('2028-04-30')
    expect(normaliseDate('1-2-2027')).toBe('2027-02-01')
    expect(normaliseDate('30.04.2028')).toBe('2028-04-30')
    expect(normaliseDate('31/04/2028')).toBeNull()
    expect(normaliseDate('2028-13-01')).toBeNull()
    expect(normaliseDate('April 2028')).toBeNull()
    expect(normaliseDate('')).toBeNull()
  })
})

describe('planOpeningStock', () => {
  const lookups: StockLookups = {
    products: new Map([
      ['AUG', { id: 'p1', tracksBatches: true, units: new Map([['TABLET', { id: 'u0', factor: 1, isBase: true }], ['BOX', { id: 'u14', factor: 14, isBase: false }]]) }],
      ['GLV', { id: 'p2', tracksBatches: false, units: new Map([['PIECE', { id: 'g0', factor: 1, isBase: true }]]) }],
    ]),
    warehouses: new Map([['MAIN', { id: 'w1' }]]),
    locations: new Map([['w1|A1', 'loc1']]),
  }
  const row = (line: number, v: Record<string, string>) => ({ line, values: v })
  const good = { sku: 'aug', warehouse: 'main', batch_number: 'B1', expiry_date: '30/04/2028', quantity: '20', unit: 'box', unit_cost: '84', location: 'a1' }

  it('shapes a valid row, resolving codes case-insensitively and day-first dates', () => {
    const [r] = planOpeningStock([row(2, good)], lookups)
    expect(r).toEqual({
      line: 2, key: 'AUG', ok: true, warehouseId: 'w1',
      stockLine: { product_id: 'p1', quantity: 20, status: 'AVAILABLE', product_unit_id: 'u14', batch_number: 'B1', expiry_date: '2028-04-30', unit_cost: 84, location_id: 'loc1' },
    })
  })
  it('leaves the unit off for base-unit rows and does not need a batch for untracked products', () => {
    const [a, b] = planOpeningStock([row(2, { ...good, unit: '', location: '' }), row(3, { sku: 'GLV', warehouse: 'MAIN', quantity: '40' })], lookups)
    expect(a!.stockLine).not.toHaveProperty('product_unit_id')
    expect(b).toMatchObject({ ok: true, stockLine: { product_id: 'p2', quantity: 40, status: 'AVAILABLE' } })
  })
  it('explains every kind of problem in the row', () => {
    const err = (v: Record<string, string>) => planOpeningStock([row(2, { ...good, ...v })], lookups)[0]!.error
    expect(err({ sku: '' })).toMatch(/SKU is missing/)
    expect(err({ sku: 'NOPE' })).toMatch(/not in your catalogue/)
    expect(err({ warehouse: 'X' })).toMatch(/warehouse "X" was not found/)
    expect(err({ quantity: '0' })).toMatch(/greater than 0/)
    expect(err({ quantity: 'abc' })).toMatch(/greater than 0/)
    expect(err({ unit: 'carton' })).toMatch(/not a unit of this product \(TABLET, BOX\)/)
    expect(err({ status: 'LOST' })).toMatch(/status must be/)
    expect(err({ batch_number: '' })).toMatch(/enter the batch number/)
    expect(err({ expiry_date: '' })).toMatch(/enter the expiry date/)
    expect(err({ expiry_date: '31/02/2028' })).toMatch(/not a valid date/)
    expect(err({ manufacture_date: '2029-01-01' })).toMatch(/after the expiry date/)
    expect(err({ unit_cost: '-1' })).toMatch(/cost/)
    expect(err({ location: 'ZZ' })).toMatch(/location "ZZ" was not found/)
    expect(planOpeningStock([row(2, { sku: 'GLV', warehouse: 'MAIN', quantity: '1', batch_number: 'X' })], lookups)[0]!.error).toMatch(/does not track batches/)
  })
  it('refuses the same batch twice in one file, pointing at the first row', () => {
    const out = planOpeningStock([row(2, good), row(3, good), row(4, { ...good, batch_number: 'B2' }), row(5, { ...good, status: 'QUARANTINE' })], lookups)
    expect(out.map((r) => r.ok)).toEqual([true, false, true, true])
    expect(out[1]!.error).toMatch(/already on row 2/)
  })
})

describe('buildTransferReceipt', () => {
  const line = (o: Partial<StockTransferLine> = {}): StockTransferLine => ({
    id: 'l1', dispatched_base: 56, received_base: 0, short_base: 0, returned_base: 0, product: { sku: 'S', brand_name: 'Augmentin', base_unit: { code: 'TABLET', name: 'Tablet' } },
    ...o,
  } as StockTransferLine)
  const part = (o = {}) => ({ ...emptyReceivePart('k', 'l1', '', 1), quantity: '10', ...o })

  it('works out what is still on its way', () => {
    expect(outstandingBase(line())).toBe(56)
    expect(outstandingBase(line({ received_base: 20, short_base: 6 }))).toBe(30)
    expect(outstandingBase(line({ received_base: 56 }))).toBe(0)
  })
  it('needs a quantity somewhere, ignores blank parts, and carries condition and location', () => {
    expect(buildTransferReceipt([part({ quantity: '' })], [line()])).toMatchObject({ ok: false })
    expect(buildTransferReceipt([part(), part({ key: 'b', quantity: '' })], [line()])).toEqual({ ok: true, lines: [{ line_id: 'l1', quantity: 10, product_unit_id: '', status: 'AVAILABLE' }] })
    const r = buildTransferReceipt([part({ status: 'DAMAGED', locationId: 'loc' })], [line()])
    expect(r.ok && r.lines[0]).toMatchObject({ status: 'DAMAGED', location_id: 'loc' })
  })
  it('never lets more than the outstanding quantity be received, across parts and earlier deliveries', () => {
    const l = line({ received_base: 40 })                    // 16 left
    expect(buildTransferReceipt([part({ quantity: '16' })], [l]).ok).toBe(true)
    expect(buildTransferReceipt([part({ quantity: '17' })], [l])).toMatchObject({ ok: false })
    expect(buildTransferReceipt([part({ quantity: '10' }), part({ key: 'b', quantity: '7' })], [l])).toMatchObject({ ok: false })
    expect(buildTransferReceipt([part({ quantity: '2', factor: 14, unitId: 'box' })], [l])).toMatchObject({ ok: false })   // 28 base units
    expect(buildTransferReceipt([part({ quantity: '0' })], [l])).toMatchObject({ ok: false })
  })
})
