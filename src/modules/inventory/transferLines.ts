import type { StockStatus } from '@/services/inventory'
import { outstandingBase, type ReceiveTransferLine, type StockTransferLine } from '@/services/transfers'

/** One delivery of part of a transfer line. A line can be split (for example some good, some damaged). */
export interface ReceivePart {
  key: string
  lineId: string
  quantity: string
  unitId: string
  /** base units in the chosen pack level */
  factor: number
  status: StockStatus
  locationId: string
}

export const emptyReceivePart = (key: string, lineId: string, unitId: string, factor: number): ReceivePart => ({
  key, lineId, quantity: '', unitId, factor, status: 'AVAILABLE', locationId: '',
})

export type ReceiveResult = { ok: true; lines: ReceiveTransferLine[] } | { ok: false; error: string }

/** Parts with a blank quantity are ignored. The total per line may not exceed what is still on its way. */
export function buildTransferReceipt(parts: ReceivePart[], lines: StockTransferLine[]): ReceiveResult {
  const byId = new Map(lines.map((l) => [l.id, l]))
  const used = parts.filter((p) => p.quantity.trim() !== '')
  if (used.length === 0) return { ok: false, error: 'Enter the quantity that arrived for at least one line.' }
  const taken = new Map<string, number>()
  const out: ReceiveTransferLine[] = []
  for (const p of used) {
    const line = byId.get(p.lineId)
    if (!line) return { ok: false, error: 'A received line does not belong to this transfer.' }
    const name = line.product?.brand_name ?? 'Product'
    const qty = Number(p.quantity)
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: `${name}: enter a quantity greater than 0.` }
    const base = qty * p.factor
    if (Math.abs(base - Math.round(base * 1000) / 1000) > 1e-9) return { ok: false, error: `${name}: the quantity has more than 3 decimals in the base unit.` }
    const sum = (taken.get(line.id) ?? 0) + base
    taken.set(line.id, sum)
    const left = outstandingBase(line)
    if (sum > left + 1e-9) return { ok: false, error: `${name}: only ${left} (in base units) is still on its way.` }
    out.push({ line_id: line.id, quantity: qty, product_unit_id: p.unitId, status: p.status, ...(p.locationId ? { location_id: p.locationId } : {}) })
  }
  return { ok: true, lines: out }
}
