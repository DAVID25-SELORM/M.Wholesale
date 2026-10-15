import { toCsv } from '@/modules/imports/csv'

/** Saves a Blob as a file (the browser's own download, no server involved). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Text that a spreadsheet would run as a formula (=, +, -, @ first) is prefixed with an apostrophe, so exported names cannot execute anything in Excel. */
export const safeCell = (v: string | number | null | undefined): string | number | null | undefined =>
  typeof v === 'string' && /^[=+\-@\t\r]/.test(v) && !/^-?\d+([.,]\d+)?$/.test(v) ? `'${v}` : v

/** Downloads rows as a CSV that opens correctly in Excel (UTF-8 with a BOM). */
export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]): void {
  const text = toCsv(rows.map((r) => r.map(safeCell)))
  saveBlob(new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' }), filename.endsWith('.csv') ? filename : `${filename}.csv`)
}
