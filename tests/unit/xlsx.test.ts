import writeExcelFile from 'write-excel-file/node'
import { describe, expect, it } from 'vitest'
import { FileProblem, readTable } from '@/modules/imports/parseFile'
import { SPECS, matchHeaders, toImportRows } from '@/modules/imports/specs'

async function xlsxFile(sheet: unknown[][], name = 'stock.xlsx'): Promise<File> {
  const buffer = await writeExcelFile(sheet as never).toBuffer()
  return new File([new Uint8Array(buffer)], name)
}

describe('reading .xlsx files', () => {
  it('reads text, numbers and dates from the first sheet into text rows', async () => {
    const file = await xlsxFile([
      ['SKU', 'Warehouse code', 'Batch', 'Expiry', 'Qty', 'Cost'],
      ['AUG-625-14', 'MAIN-HQ', 'AUG2601', { value: new Date(Date.UTC(2028, 3, 30)), format: 'yyyy-mm-dd' }, 20, 84.5],
      ['PANADOL-500-100', 'MAIN-HQ', 'PN-7731', { value: new Date(Date.UTC(2027, 11, 31)), format: 'dd/mm/yyyy' }, 5000, 0.21],
    ])
    const table = await readTable(file)
    expect(table).toEqual([
      ['SKU', 'Warehouse code', 'Batch', 'Expiry', 'Qty', 'Cost'],
      ['AUG-625-14', 'MAIN-HQ', 'AUG2601', '2028-04-30', '20', '84.5'],
      ['PANADOL-500-100', 'MAIN-HQ', 'PN-7731', '2027-12-31', '5000', '0.21'],
    ])
    const spec = SPECS.opening_stock
    const m = matchHeaders(table[0]!, spec)
    expect(m.missing).toEqual([])
    expect(toImportRows(table, m.mapping)[0]!.values).toMatchObject({ sku: 'AUG-625-14', warehouse: 'MAIN-HQ', batch_number: 'AUG2601', expiry_date: '2028-04-30', quantity: '20', unit_cost: '84.5' })
  })

  it('drops completely empty rows and keeps long barcodes intact', async () => {
    const file = await xlsxFile([['SKU', 'Name', 'Barcode'], ['A1', 'Aspirin', 6001087000017], [null, null, null], ['B2', 'Brufen', '5000000000000']], 'products.xlsx')
    const table = await readTable(file)
    expect(table).toEqual([['SKU', 'Name', 'Barcode'], ['A1', 'Aspirin', '6001087000017'], ['B2', 'Brufen', '5000000000000']])
  })

  it('explains files it cannot use', async () => {
    await expect(readTable(new File([''], 'empty.csv'))).rejects.toThrow(FileProblem)
    await expect(readTable(new File(['sku\n'], 'headers-only.csv'))).rejects.toThrow(/no data rows/)
    await expect(readTable(new File(['x'], 'old.xls'))).rejects.toThrow(/\.xls/)
    await expect(readTable(new File(['x'], 'notes.docx'))).rejects.toThrow(/Excel \(\.xlsx\) or CSV/)
    await expect(readTable(new File(['this is not a zip'], 'broken.xlsx'))).rejects.toThrow(/could not be read/)
    await expect(readTable(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'huge.csv'))).rejects.toThrow(/larger than 5 MB/)
  })

  it('reads a CSV the way Excel saves it (semicolons, quotes, BOM)', async () => {
    const csv = '﻿SKU;Product Name;Base unit\r\nA1;"Aspirin ""Junior"", 75 mg";TABLET\r\n'
    expect(await readTable(new File([csv], 'products.csv'))).toEqual([['SKU', 'Product Name', 'Base unit'], ['A1', 'Aspirin "Junior", 75 mg', 'TABLET']])
  })
})
