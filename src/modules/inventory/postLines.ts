import type { ProductRow } from '@/services/catalog'
import { fmtQty, type BalanceRow, type DocumentType, type PostLine, type StockStatus } from '@/services/inventory'

/** One editable row of the posting dialog. */
export interface LineDraft {
  key: string
  product: ProductRow | null
  /** does the product track batches / expiry? (decides whether batch fields are needed) */
  tracks: boolean
  unitId: string
  /** base units in one of the chosen pack level */
  factor: number
  quantity: string
  /** ADJUSTMENT only */
  direction: 'IN' | 'OUT'
  /** the existing stock this line takes from (transfer, status change, adjustment OUT) */
  balance: BalanceRow | null
  batchNumber: string
  expiry: string
  mfg: string
  /** where incoming stock goes (opening, adjustment IN) */
  locationId: string
  /** status of incoming stock (opening, adjustment IN) */
  status: StockStatus
  toStatus: StockStatus
  toLocationId: string
}

export const emptyLine = (key: string): LineDraft => ({
  key, product: null, tracks: true, unitId: '', factor: 1, quantity: '', direction: 'IN', balance: null,
  batchNumber: '', expiry: '', mfg: '', locationId: '', status: 'AVAILABLE', toStatus: 'QUARANTINE', toLocationId: '',
})

/** Does this line take stock out of an existing balance? */
export const takesFromStock = (type: DocumentType, l: Pick<LineDraft, 'direction'>) =>
  type === 'TRANSFER' || type === 'STATUS_CHANGE' || (type === 'ADJUSTMENT' && l.direction === 'OUT')

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export type BuildResult = { ok: true; lines: PostLine[] } | { ok: false; error: string }

/** Validates the drafts the way a careful clerk would, and shapes them for post_stock_document(). The database re-checks everything. */
export function buildPostLines(type: DocumentType, drafts: LineDraft[]): BuildResult {
  if (drafts.length === 0) return { ok: false, error: 'Add at least one line.' }
  const lines: PostLine[] = []
  const taken = new Map<string, { base: number; available: number; label: string }>()

  for (const [i, l] of drafts.entries()) {
    const n = i + 1
    const fail = (m: string): BuildResult => ({ ok: false, error: `Line ${n}: ${m}` })
    if (!l.product) return fail('choose a product.')
    const qty = Number(l.quantity)
    if (l.quantity.trim() === '' || !Number.isFinite(qty) || qty <= 0) return fail('enter a quantity greater than 0.')
    const base = qty * l.factor
    if (Math.abs(base - Math.round(base * 1000) / 1000) > 1e-9) return fail('the quantity has more than 3 decimals in the base unit.')

    const line: PostLine = { product_id: l.product.id, quantity: qty }
    if (l.unitId) line.product_unit_id = l.unitId

    if (takesFromStock(type, l)) {
      if (!l.balance) return fail('choose which stock to take from.')
      const b = l.balance
      if (b.batch_id) line.batch_id = b.batch_id
      if (b.location_id) line.location_id = b.location_id
      line.status = b.stock_status
      const acc = taken.get(b.id) ?? { base: 0, available: b.quantity, label: `${l.product.brand_name} ${b.batch?.batch_number ?? ''}`.trim() }
      acc.base += base
      taken.set(b.id, acc)
      if (acc.base > acc.available + 1e-9) return fail(`only ${fmtQty(acc.available)} available in that stock.`)
      if (type === 'ADJUSTMENT') line.direction = 'OUT'
      if (type === 'TRANSFER' && l.toLocationId) line.to_location_id = l.toLocationId
      if (type === 'STATUS_CHANGE') {
        line.to_status = l.toStatus
        if (l.toLocationId) line.to_location_id = l.toLocationId
        if (l.toStatus === b.stock_status && (l.toLocationId || null) === (b.location_id ?? null)) return fail('nothing to change - pick a different status or location.')
      }
    } else {
      // opening stock or an upward adjustment: stock comes in, possibly in a new batch
      if (l.tracks) {
        if (!l.batchNumber.trim()) return fail('enter the batch number.')
        if (!ISO_DATE.test(l.expiry)) return fail('enter the expiry date.')
        if (l.mfg && !ISO_DATE.test(l.mfg)) return fail('the manufacture date is not valid.')
        if (l.mfg && l.mfg > l.expiry) return fail('the manufacture date is after the expiry date.')
        line.batch_number = l.batchNumber.trim()
        line.expiry_date = l.expiry
        if (l.mfg) line.manufacture_date = l.mfg
      }
      if (l.locationId) line.location_id = l.locationId
      line.status = l.status
      if (type === 'ADJUSTMENT') line.direction = 'IN'
    }
    lines.push(line)
  }
  return { ok: true, lines }
}
