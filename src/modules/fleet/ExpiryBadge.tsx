import { Badge } from '@/components/ui'
import { EXPIRY_LABEL, EXPIRY_TONE, expiryState } from './expiry'

export function ExpiryBadge({ date, warningDays }: { date: string | null; warningDays: number }) {
  const state = expiryState(date, warningDays)
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-slate-700">{date ?? '—'}</span>
      <Badge tone={EXPIRY_TONE[state]}>{EXPIRY_LABEL[state]}</Badge>
    </span>
  )
}
