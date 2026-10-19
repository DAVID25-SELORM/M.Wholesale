export type ExpiryState = 'missing' | 'expired' | 'soon' | 'valid'

/** Whole days from `today` to the date (negative once past). Dates are plain yyyy-mm-dd calendar days, compared without time zones. */
export function daysUntil(date: string, today: Date = new Date()): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const target = Date.UTC(y, m - 1, d)
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((target - now) / 86_400_000)
}

/** A date on the expiry day itself is still valid (it is the last valid day); the warning starts `warningDays` before it. */
export function expiryState(date: string | null | undefined, warningDays: number, today: Date = new Date()): ExpiryState {
  if (!date) return 'missing'
  const n = daysUntil(date, today)
  if (n < 0) return 'expired'
  return n <= warningDays ? 'soon' : 'valid'
}

export const EXPIRY_LABEL: Record<ExpiryState, string> = { missing: 'Not recorded', expired: 'Expired', soon: 'Expiring soon', valid: 'Valid' }
export const EXPIRY_TONE: Record<ExpiryState, 'slate' | 'red' | 'amber' | 'green'> = { missing: 'slate', expired: 'red', soon: 'amber', valid: 'green' }
