import { describe, expect, it } from 'vitest'
import { safeCell } from '@/lib/download'
import { buildReminderMessage, whatsappNumber } from '@/modules/sales/reminderText'

const invoices = [
  { number: 'INV-2026-000007', due: '2026-09-01', amount: 100, daysLate: 44 },
  { number: 'INV-2026-000009', due: '2026-10-05', amount: 50.5, daysLate: 10 },
]
const base = { customerName: 'Adom Pharmacy', contactName: 'Kofi', organization: 'Demo Wholesale', organizationPhone: '0302 000 111', invoices }

describe('buildReminderMessage', () => {
  it('lists exactly the chosen invoices with the total, addressed to the contact', () => {
    const m = buildReminderMessage({ ...base, level: 1 })
    expect(m).toContain('Dear Kofi,')
    expect(m).toContain('INV-2026-000007  due 2026-09-01 (44 days late)  GHS 100.00')
    expect(m).toContain('GHS 50.50')
    expect(m).toContain('Total overdue: GHS 150.50.')
    expect(m).toContain('0302 000 111')
    expect(m.trim().endsWith('Demo Wholesale')).toBe(true)
  })
  it('gets firmer with each level and falls back to the customer name and no phone line', () => {
    const l1 = buildReminderMessage({ ...base, level: 1, contactName: null, organizationPhone: null })
    expect(l1).toContain('Dear Adom Pharmacy,')
    expect(l1).not.toContain('please call us')
    expect(buildReminderMessage({ ...base, level: 2 })).toContain('despite our earlier reminder')
    expect(buildReminderMessage({ ...base, level: 3 })).toContain('FINAL NOTICE')
    expect(buildReminderMessage({ ...base, level: 3 })).toContain('place your account on hold')
    expect(buildReminderMessage({ ...base, level: 1, invoices: [{ number: 'X', due: '2026-10-14', amount: 1, daysLate: 1 }] })).toContain('(1 day late)')
  })
})

describe('whatsappNumber', () => {
  it('turns Ghanaian and international numbers into wa.me digits', () => {
    expect(whatsappNumber('024 400 0111')).toBe('233244000111')
    expect(whatsappNumber('0244000111')).toBe('233244000111')
    expect(whatsappNumber('+233 24 400 0111')).toBe('233244000111')
    expect(whatsappNumber('00233244000111')).toBe('233244000111')
    expect(whatsappNumber('244000111')).toBe('233244000111')
    expect(whatsappNumber('+44 7700 900123')).toBe('447700900123')
    expect(whatsappNumber('123')).toBeNull()
    expect(whatsappNumber(null)).toBeNull()
  })
})

describe('safeCell (spreadsheet formula injection)', () => {
  it('prefixes text that a spreadsheet would run as a formula, but leaves numbers and normal text alone', () => {
    expect(safeCell('=HYPERLINK("http://evil")')).toBe(`'=HYPERLINK("http://evil")`)
    expect(safeCell('+233 24 400 0111')).toBe("'+233 24 400 0111")
    expect(safeCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(safeCell('-cmd')).toBe("'-cmd")
    expect(safeCell('Adom Pharmacy')).toBe('Adom Pharmacy')
    expect(safeCell('-12.50')).toBe('-12.50')
    expect(safeCell(-12.5)).toBe(-12.5)
    expect(safeCell(null)).toBeNull()
  })
})
