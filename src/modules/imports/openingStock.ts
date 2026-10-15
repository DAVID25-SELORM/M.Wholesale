import type { PostLine, StockStatus } from '@/services/inventory'
import type { ImportRow } from './specs'

export interface ProductLookup {
  id: string
  tracksBatches: boolean
  /** pack levels by unit code (upper case); the base unit has factor 1 */
  units: Map<string, { id: string; factor: number; isBase: boolean }>
}

export interface StockLookups {
  /** by SKU (upper case) */
  products: Map<string, ProductLookup>
  /** by warehouse code (upper case) */
  warehouses: Map<string, { id: string }>
  /** by `${warehouseId}|${CODE}` */
  locations: Map<string, string>
}

export interface OpeningPlanRow {
  line: number
  key: string
  ok: boolean
  error?: string
  warehouseId?: string
  stockLine?: PostLine
}

const STATUSES: StockStatus[] = ['AVAILABLE', 'QUARANTINE', 'DAMAGED', 'EXPIRED']

/** Accepts YYYY-MM-DD and DD/MM/YYYY (also - or . as separators). Returns YYYY-MM-DD, or null when it is not a real date. */
export function normaliseDate(s: string): string | null {
  const t = s.trim()
  let y: number, m: number, d: number
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)
  if (match) { y = +match[1]!; m = +match[2]!; d = +match[3]! } else {
    match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t)
    if (!match) return null
    d = +match[1]!; m = +match[2]!; y = +match[3]!
  }
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Checks every row against the catalogue and the warehouses, and shapes the ones that are fine for post_stock_document(). */
export function planOpeningStock(rows: ImportRow[], lookups: StockLookups): OpeningPlanRow[] {
  const seen = new Map<string, number>()
  return rows.map(({ line, values: v }) => {
    const sku = (v.sku ?? '').toUpperCase()
    const fail = (error: string): OpeningPlanRow => ({ line, key: sku || '—', ok: false, error })

    const product = lookups.products.get(sku)
    if (!sku) return fail('the SKU is missing')
    if (!product) return fail(`SKU "${sku}" is not in your catalogue (import the products first)`)
    const whCode = (v.warehouse ?? '').toUpperCase()
    const warehouse = lookups.warehouses.get(whCode)
    if (!whCode) return fail('the warehouse code is missing')
    if (!warehouse) return fail(`warehouse "${v.warehouse}" was not found, or you cannot post to it`)

    const qty = Number(v.quantity)
    if ((v.quantity ?? '') === '' || !Number.isFinite(qty) || qty <= 0) return fail('the quantity must be a number greater than 0')

    let unitId: string | undefined
    let factor = 1
    if (v.unit) {
      const unit = product.units.get(v.unit.toUpperCase())
      if (!unit) return fail(`"${v.unit}" is not a unit of this product (${[...product.units.keys()].join(', ')})`)
      factor = unit.factor
      if (!unit.isBase) unitId = unit.id
    }
    const base = qty * factor
    if (Math.abs(base - Math.round(base * 1000) / 1000) > 1e-9) return fail('the quantity has more than 3 decimals in the base unit')

    const status = (v.status ? v.status.toUpperCase() : 'AVAILABLE') as StockStatus
    if (!STATUSES.includes(status)) return fail('the status must be AVAILABLE, QUARANTINE, DAMAGED or EXPIRED')

    const out: PostLine = { product_id: product.id, quantity: qty, status }
    if (unitId) out.product_unit_id = unitId

    if (product.tracksBatches) {
      if (!v.batch_number) return fail('this product tracks batches: enter the batch number')
      const expiry = normaliseDate(v.expiry_date ?? '')
      if (!v.expiry_date) return fail('this product tracks batches: enter the expiry date')
      if (!expiry) return fail('the expiry date is not a valid date (use YYYY-MM-DD or DD/MM/YYYY)')
      out.batch_number = v.batch_number
      out.expiry_date = expiry
      if (v.manufacture_date) {
        const mfg = normaliseDate(v.manufacture_date)
        if (!mfg) return fail('the manufacture date is not a valid date')
        if (mfg > expiry) return fail('the manufacture date is after the expiry date')
        out.manufacture_date = mfg
      }
      if (v.unit_cost) {
        const cost = Number(v.unit_cost)
        if (!Number.isFinite(cost) || cost < 0) return fail('the cost must be a number, 0 or more')
        out.unit_cost = cost
      }
    } else if (v.batch_number || v.expiry_date) {
      return fail('this product does not track batches: leave the batch number and expiry date blank')
    }

    if (v.location) {
      const loc = lookups.locations.get(`${warehouse.id}|${v.location.toUpperCase()}`)
      if (!loc) return fail(`location "${v.location}" was not found in warehouse ${whCode}`)
      out.location_id = loc
    }

    const dupKey = [warehouse.id, product.id, (v.batch_number ?? '').toUpperCase(), out.location_id ?? '', status].join('|')
    const first = seen.get(dupKey)
    if (first !== undefined) return fail(`the same batch is already on row ${first} of this file - combine them into one row`)
    seen.set(dupKey, line)

    return { line, key: sku, ok: true, warehouseId: warehouse.id, stockLine: out }
  })
}
