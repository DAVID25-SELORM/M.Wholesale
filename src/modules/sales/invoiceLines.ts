import type { ProductRow } from '@/services/catalog'
import { computeLine, round2, type SaveSalesLine } from '@/services/sales'

/** One editable line of a draft invoice. */
export interface SalesLineDraft {
  key: string
  product: ProductRow | null
  unitId: string
  /** base units in the chosen pack level */
  factor: number
  quantity: string
  /** what the price list says for this pack level (null = none) */
  listPrice: number | null
  /** the price the user typed (blank = use the list price) */
  price: string
  discount: string
  /** the tax rate that will apply (from the product's tax code, else the default code) */
  taxRate: number
}

export const emptySalesLine = (key: string): SalesLineDraft => ({
  key, product: null, unitId: '', factor: 1, quantity: '', listPrice: null, price: '', discount: '', taxRate: 0,
})

export const effectivePrice = (l: Pick<SalesLineDraft, 'price' | 'listPrice'>): number | null => {
  if (l.price.trim() !== '') { const n = Number(l.price); return Number.isFinite(n) ? n : null }
  return l.listPrice
}

export type SalesLinesResult = { ok: true; lines: SaveSalesLine[]; subtotal: number; discount: number; tax: number; total: number } | { ok: false; error: string }

export interface SalesRights { canOverridePrice: boolean; canDiscount: boolean }

/** Validates the lines the way the database will, and totals them with the same rounding. */
export function buildSalesLines(drafts: SalesLineDraft[], rights: SalesRights): SalesLinesResult {
  if (drafts.length === 0) return { ok: false, error: 'Add at least one line.' }
  const seen = new Set<string>()
  const lines: SaveSalesLine[] = []
  let subtotal = 0, discount = 0, tax = 0
  for (const [i, d] of drafts.entries()) {
    const fail = (m: string): SalesLinesResult => ({ ok: false, error: `Line ${i + 1}: ${m}` })
    if (!d.product) return fail('choose a product.')
    const qty = Number(d.quantity)
    if (d.quantity.trim() === '' || !Number.isFinite(qty) || qty <= 0) return fail('enter a quantity greater than 0.')
    if (Math.abs(qty - Number(qty.toFixed(3))) > 1e-9) return fail('the quantity can have at most 3 decimals.')
    const price = effectivePrice(d)
    if (price === null) return fail(d.price.trim() !== '' ? 'the price is not a number.' : `${d.product.sku} has no price on any price list - add it to a price list${rights.canOverridePrice ? ' or type a price' : ''}.`)
    if (price < 0 || Math.abs(price - Number(price.toFixed(4))) > 1e-9) return fail('the price must be 0 or more with at most 4 decimals.')
    const namedPrice = d.price.trim() !== '' && (d.listPrice === null || price !== d.listPrice)
    if (namedPrice && !rights.canOverridePrice) return fail('you are not allowed to sell at a price other than the price list.')
    const disc = d.discount.trim() === '' ? 0 : Number(d.discount)
    if (!Number.isFinite(disc) || disc < 0 || disc > 100 || Math.abs(disc - Number(disc.toFixed(2))) > 1e-9) return fail('the discount must be between 0 and 100 %.')
    if (disc > 0 && !rights.canDiscount) return fail('you are not allowed to give discounts.')
    const key = `${d.product.id}|${d.unitId}|${price}|${disc}`
    if (seen.has(key)) return fail('the same product, pack, price and discount is already on the invoice - increase its quantity.')
    seen.add(key)
    const c = computeLine(qty, price, disc, d.taxRate)
    subtotal += c.net; discount += c.discount; tax += c.tax
    lines.push({ product_id: d.product.id, quantity: qty, ...(d.unitId ? { product_unit_id: d.unitId } : {}), ...(d.price.trim() !== '' ? { unit_price: price } : {}), ...(disc > 0 ? { discount_percent: disc } : {}) })
  }
  return { ok: true, lines, subtotal: round2(subtotal), discount: round2(discount), tax: round2(tax), total: round2(subtotal + tax) }
}
