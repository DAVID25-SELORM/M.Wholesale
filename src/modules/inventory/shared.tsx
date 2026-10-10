import { Badge } from '@/components/ui'
import { STOCK_STATUS_LABEL, expiryLabel, expiryTone, type StockStatus } from '@/services/inventory'

const STATUS_TONE: Record<StockStatus, 'green' | 'amber' | 'red' | 'slate'> = {
  AVAILABLE: 'green', QUARANTINE: 'amber', DAMAGED: 'red', EXPIRED: 'slate',
}

export function StockStatusBadge({ status }: { status: StockStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STOCK_STATUS_LABEL[status]}</Badge>
}

export function ExpiryBadge({ days }: { days: number }) {
  return <Badge tone={expiryTone(days)}>{expiryLabel(days)}</Badge>
}
