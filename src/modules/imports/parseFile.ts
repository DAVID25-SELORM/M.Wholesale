import { parseCsv } from './csv'

export const MAX_FILE_BYTES = 5 * 1024 * 1024
export const MAX_DATA_ROWS = 5000

export class FileProblem extends Error {}

/** One spreadsheet cell as text. Dates become YYYY-MM-DD, yes/no stay yes/no, numbers are written without exponents. */
export function cellToString(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return ''
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`
  }
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'number') return Number.isFinite(v) ? v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 10 }) : ''
  return String(v).trim()
}

/** Reads a .csv or .xlsx file (first sheet) into rows of text. The first row is the header. */
export async function readTable(file: File): Promise<string[][]> {
  if (file.size === 0) throw new FileProblem('That file is empty.')
  if (file.size > MAX_FILE_BYTES) throw new FileProblem('That file is larger than 5 MB. Split it into smaller files.')
  const name = file.name.toLowerCase()
  let table: string[][]
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    table = parseCsv(await file.text())
  } else if (name.endsWith('.xlsx')) {
    // loaded on demand: the spreadsheet reader is only needed here
    const { readSheet } = await import('read-excel-file/web-worker')
    let sheet: unknown[][]
    try {
      sheet = (await readSheet(file)) as unknown[][]
    } catch {
      throw new FileProblem('That Excel file could not be read. Save it again as .xlsx (or export it as CSV) and retry.')
    }
    table = sheet.map((r) => r.map(cellToString)).filter((r) => r.some((c) => c !== ''))
  } else if (name.endsWith('.xls')) {
    throw new FileProblem('Old .xls files are not supported. In Excel, choose File → Save As → Excel Workbook (.xlsx) or CSV.')
  } else {
    throw new FileProblem('Choose an Excel (.xlsx) or CSV file.')
  }
  if (table.length < 2) throw new FileProblem('The file has no data rows. The first row must be the column headings.')
  if (table.length - 1 > MAX_DATA_ROWS) throw new FileProblem(`The file has more than ${MAX_DATA_ROWS.toLocaleString()} rows. Split it into smaller files.`)
  return table
}
