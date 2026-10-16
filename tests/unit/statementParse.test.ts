import { describe, expect, it } from 'vitest'
import { parseAmount, parseDate, parseStatement, StatementProblem } from '@/modules/accounting/statementParse'

describe('bank statement parsing', () => {
  it('reads dates the way banks print them, and rejects impossible ones', () => {
    expect(parseDate('2026-03-31')).toBe('2026-03-31')
    expect(parseDate('31/03/2026')).toBe('2026-03-31')
    expect(parseDate('1.4.26')).toBe('2026-04-01')
    expect(parseDate('31-12-2025')).toBe('2025-12-31')
    expect(parseDate('31/02/2026')).toBeNull()
    expect(parseDate('03/31/2026')).toBeNull()
    expect(parseDate('yesterday')).toBeNull()
  })

  it('reads amounts with thousands separators, brackets and DR/CR markers', () => {
    expect(parseAmount('1,234.50')).toBe(1234.5)
    expect(parseAmount('(120.00)')).toBe(-120)
    expect(parseAmount('-45')).toBe(-45)
    expect(parseAmount('300.00 DR')).toBe(-300)
    expect(parseAmount('300.00 CR')).toBe(300)
    expect(parseAmount('')).toBe(0)
    expect(parseAmount('12.345')).toBeNull()
    expect(parseAmount('abc')).toBeNull()
  })

  it('parses a single-amount layout, in either column order, ignoring blank rows', () => {
    const p = parseStatement([
      ['Reference', 'Narration', 'Amount', 'Transaction Date'],
      ['TRF-1', 'Customer payment', '1,000.00', '02/03/2026'],
      ['', '', '', ''],
      ['CHQ-9', 'Cheque', '(250.50)', '05/03/2026'],
    ])
    expect(p.lines).toEqual([
      { date: '2026-03-02', description: 'Customer payment', reference: 'TRF-1', amount: 1000 },
      { date: '2026-03-05', description: 'Cheque', reference: 'CHQ-9', amount: -250.5 },
    ])
    expect(p).toMatchObject({ from: '2026-03-02', to: '2026-03-05', total: 749.5 })
  })

  it('parses separate debit and credit columns (money out negative) and skips zero rows', () => {
    const p = parseStatement([['Date', 'Details', 'Withdrawal', 'Deposit'], ['2026-03-01', 'Fee', '12.00', ''], ['2026-03-01', 'Memo', '', ''], ['2026-03-02', 'Deposit', '', '500']])
    expect(p.lines.map((l) => l.amount)).toEqual([-12, 500])
  })

  it('explains what is wrong with a file it cannot use', () => {
    expect(() => parseStatement([['Details', 'Amount'], ['x', '1']])).toThrow(/"Date" column/)
    expect(() => parseStatement([['Date', 'Details'], ['2026-03-01', 'x']])).toThrow(/"Amount" column/)
    expect(() => parseStatement([['Date', 'Amount'], ['someday', '1']])).toThrow(/Row 2: the date/)
    expect(() => parseStatement([['Date', 'Amount'], ['2026-03-01', 'lots']])).toThrow(/Row 2: the amount/)
    expect(() => parseStatement([['Date', 'Amount'], ['2026-03-01', '0']])).toThrow(StatementProblem)
  })
})
