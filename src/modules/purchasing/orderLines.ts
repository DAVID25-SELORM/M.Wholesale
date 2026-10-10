import type { ProductRow } from '@/services/catalog'
import type { PurchaseOrderLine, ReceiveLine, ReceiptStatus, SaveOrderLine } from '@/services/purchasing'

// ---- order lines ------------------------------------------------------------------------------------------------
export interface OrderLineDraft {
  key: string
  product: ProductRow | null
  unitId: string
  quantity: string
  cost: string
}

export const emptyOrderLine = (key: string): OrderLineDraft => ({ key, product: null, unitId: '', quantity: '', cost: '' })

export type OrderLinesResult = { ok: true; lines: SaveOrderLine[]; total: number } | { ok: false; error: string }

const decimals = (n: number, max: number) => Math.abs(n - Number(n.toFixed(max))) < 1e-9

/** Validates the lines of a purchase order the way the database will (and computes the total for display). */
export function buildOrderLines(drafts: OrderLineDraft[]): OrderLinesResult {
  if (drafts.length === 0) return { ok: false, error: 'Add at least one line.' }
  const seen = new Set<string>()
  const lines: SaveOrderLine[] = []
  let total = 0
  for (const [i, d] of drafts.entries()) {
    const fail = (m: string): OrderLinesResult => ({ ok: false, error: `Line ${i + 1}: ${m}` })
    if (!d.product) return fail('choose a product.')
    const qty = Number(d.quantity)
    if (d.quantity.trim() === '' || !Number.isFinite(qty) || qty <= 0) return fail('enter a quantity greater than 0.')
    if (!decimals(qty, 3)) return fail('the quantity can have at most 3 decimals.')
    const cost = Number(d.cost)
    if (d.cost.trim() === '' || !Number.isFinite(cost) || cost < 0) return fail('enter the cost per pack (0 or more).')
    if (!decimals(cost, 4)) return fail('the cost can have at most 4 decimals.')
    const key = `${d.product.id}|${d.unitId}`
    if (seen.has(key)) return fail('this product and pack level is already on the order.')
    seen.add(key)
    lines.push({ product_id: d.product.id, quantity: qty, unit_cost: cost, ...(d.unitId ? { product_unit_id: d.unitId } : {}) })
    total += Math.round(qty * cost * 100) / 100
  }
  return { ok: true, lines, total: Math.round(total * 100) / 100 }
}

// ---- receiving --------------------------------------------------------------------------------------------------
export interface ReceivePart {
  key: string
  poLineId: string
  quantity: string
  unitId: string
  /** base units in the chosen pack level (the ordered one by default) */
  factor: number
  batch: string
  expiry: string
  mfg: string
  locationId: string
  status: ReceiptStatus
}

export const emptyPart = (key: string, line: Pick<PurchaseOrderLine, 'id' | 'product_unit_id'> & { factor: number }): ReceivePart => ({
  key, poLineId: line.id, quantity: '', unitId: line.product_unit_id, factor: line.factor, batch: '', expiry: '', mfg: '', locationId: '', status: 'AVAILABLE',
})

export type ReceiveResult = { ok: true; lines: ReceiveLine[] } | { ok: false; error: string }
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Parts with a blank quantity are ignored (nothing arrived for that line). */
export function buildReceiveLines(parts: ReceivePart[], lines: PurchaseOrderLine[]): ReceiveResult {
  const byId = new Map(lines.map((l) => [l.id, l]))
  const used = parts.filter((p) => p.quantity.trim() !== '')
  if (used.length === 0) return { ok: false, error: 'Enter the quantity received for at least one line.' }
  const taken = new Map<string, number>()
  const out: ReceiveLine[] = []
  for (const p of used) {
    const line = byId.get(p.poLineId)
    if (!line) return { ok: false, error: 'A received line does not belong to this order.' }
    const name = line.product?.brand_name ?? 'Product'
    const fail = (m: string): ReceiveResult => ({ ok: false, error: `${name}: ${m}` })
    const qty = Number(p.quantity)
    if (!Number.isFinite(qty) || qty <= 0) return fail('enter a quantity greater than 0.')
    const base = qty * p.factor
    if (!decimals(base, 3)) return fail('the quantity has more than 3 decimals in the base unit.')
    const sum = (taken.get(line.id) ?? 0) + base
    taken.set(line.id, sum)
    const remaining = Number(line.ordered_base) - Number(line.received_base)
    if (sum > remaining + 1e-9) return fail(`only ${remaining} (in base units) are still expected - you cannot receive more than was ordered.`)

    const r: ReceiveLine = { po_line_id: line.id, quantity: qty, product_unit_id: p.unitId, status: p.status }
    if (line.product?.track_batches) {
      if (!p.batch.trim()) return fail('enter the batch number.')
      if (!ISO_DATE.test(p.expiry)) return fail('enter the expiry date.')
      if (p.mfg && (!ISO_DATE.test(p.mfg) || p.mfg > p.expiry)) return fail('the manufacture date must be a valid date before the expiry date.')
      r.batch_number = p.batch.trim()
      r.expiry_date = p.expiry
      if (p.mfg) r.manufacture_date = p.mfg
    }
    if (p.locationId) r.location_id = p.locationId
    out.push(r)
  }
  return { ok: true, lines: out }
}
