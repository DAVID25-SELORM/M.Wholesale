import type { ImportLine } from '@/services/accounting'

export class StatementProblem extends Error {}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
const find = (header: string[], names: string[]) => header.findIndex((h) => names.includes(norm(h)))

/** Accepts 2026-03-31, 31/03/2026, 31-03-2026 and 31.03.2026 (day first, the way Ghanaian banks print dates). */
export function parseDate(text: string): string | null {
  const t = text.trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t)
  let y: number, mo: number, d: number
  if (m) { y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]) } else {
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t)
    if (!m) return null
    d = Number(m[1]); mo = Number(m[2]); y = Number(m[3]); if (y < 100) y += 2000
  }
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** "1,234.50", "(120.00)", "-120", "120 DR" -> a number; money out is negative. Empty -> 0. */
export function parseAmount(text: string): number | null {
  let t = text.trim()
  if (t === '') return 0
  let sign = 1
  if (/^\(.*\)$/.test(t)) { sign = -1; t = t.slice(1, -1) }
  if (/\bdr\b/i.test(t)) { sign = -1; t = t.replace(/\bdr\b/i, '') }
  t = t.replace(/\bcr\b/i, '').replace(/[,\s]/g, '')
  if (t.startsWith('-')) { sign = -sign; t = t.slice(1) }
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null
  return sign * Number(t)
}

export interface ParsedStatement { lines: ImportLine[]; from: string; to: string; total: number }

/**
 * Turns a bank export (first row = headings) into statement lines. Needs a date column and either one amount column (money out negative) or separate
 * debit/withdrawal and credit/deposit columns. Description and reference columns are optional.
 */
export function parseStatement(table: string[][]): ParsedStatement {
  const header = table[0] ?? []
  const date = find(header, ['date', 'transactiondate', 'txndate', 'valuedate', 'postingdate', 'postdate'])
  const desc = find(header, ['description', 'narration', 'details', 'narrative', 'particulars', 'transactiondetails'])
  const ref = find(header, ['reference', 'ref', 'referencenumber', 'chequeno', 'cheque', 'transactionid', 'txnid'])
  const amount = find(header, ['amount'])
  const debit = find(header, ['debit', 'withdrawal', 'withdrawals', 'moneyout', 'paidout', 'dr'])
  const credit = find(header, ['credit', 'deposit', 'deposits', 'moneyin', 'paidin', 'cr'])
  if (date < 0) throw new StatementProblem('The file needs a "Date" column.')
  if (amount < 0 && (debit < 0 || credit < 0)) throw new StatementProblem('The file needs an "Amount" column, or both "Debit" and "Credit" columns.')

  const lines: ImportLine[] = []
  for (let i = 1; i < table.length; i++) {
    const row = table[i] ?? []
    if (row.every((c) => (c ?? '').trim() === '')) continue
    const d = parseDate(row[date] ?? '')
    if (!d) throw new StatementProblem(`Row ${i + 1}: the date "${row[date] ?? ''}" is not understood (use 31/03/2026 or 2026-03-31).`)
    let amt: number | null
    if (amount >= 0) amt = parseAmount(row[amount] ?? '')
    else {
      const dr = parseAmount(row[debit] ?? ''); const cr = parseAmount(row[credit] ?? '')
      amt = dr === null || cr === null ? null : Math.round((Math.abs(cr) - Math.abs(dr)) * 100) / 100
    }
    if (amt === null) throw new StatementProblem(`Row ${i + 1}: the amount is not a number.`)
    if (amt === 0) continue
    lines.push({ date: d, description: (desc >= 0 ? row[desc] ?? '' : '').trim().slice(0, 300), reference: (ref >= 0 ? row[ref] ?? '' : '').trim().slice(0, 100), amount: Math.round(amt * 100) / 100 })
  }
  if (lines.length === 0) throw new StatementProblem('No transactions were found in the file.')
  const dates = lines.map((l) => l.date).sort()
  return { lines, from: dates[0]!, to: dates[dates.length - 1]!, total: Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100 }
}
