import type { InvoiceLineInput, MatchStatus } from '@/services/payables'

/** One order line on the invoice form. */
export interface InvoiceLineDraft {
  poLineId: string
  include: boolean
  quantity: string
  price: string
  /** what the order says (price per pack) and what can still be billed (packs) - used only for the preview */
  poPrice: number
  allowed: number
}

export type InvoiceLinesResult = { ok: true; lines: InvoiceLineInput[]; subtotal: number } | { ok: false; error: string }

const decimals = (n: number, max: number) => Math.abs(n - Number(n.toFixed(max))) < 1e-9

export function buildInvoiceLines(drafts: InvoiceLineDraft[], names: Record<string, string> = {}): InvoiceLinesResult {
  const used = drafts.filter((d) => d.include)
  if (used.length === 0) return { ok: false, error: 'Tick at least one line that is on the supplier’s invoice.' }
  const lines: InvoiceLineInput[] = []
  let subtotal = 0
  for (const d of used) {
    const name = names[d.poLineId] ?? 'A line'
    const qty = Number(d.quantity)
    if (d.quantity.trim() === '' || !Number.isFinite(qty) || qty <= 0) return { ok: false, error: `${name}: enter the invoiced quantity (more than 0).` }
    if (!decimals(qty, 3)) return { ok: false, error: `${name}: the quantity can have at most 3 decimals.` }
    const price = Number(d.price)
    if (d.price.trim() === '' || !Number.isFinite(price) || price < 0) return { ok: false, error: `${name}: enter the invoiced price per pack (0 or more).` }
    if (!decimals(price, 4)) return { ok: false, error: `${name}: the price can have at most 4 decimals.` }
    lines.push({ po_line_id: d.poLineId, quantity: qty, unit_price: price })
    subtotal += Math.round(qty * price * 100) / 100
  }
  return { ok: true, lines, subtotal: Math.round(subtotal * 100) / 100 }
}

/** The same rule the database applies (quantity within what was received and not yet billed; price within 1 % of the order). */
export function previewMatch(d: Pick<InvoiceLineDraft, 'quantity' | 'price' | 'poPrice' | 'allowed'>): MatchStatus {
  const qty = Number(d.quantity)
  const price = Number(d.price)
  const qtyOk = !Number.isFinite(qty) || qty <= d.allowed + 0.0005
  const priceOk = !Number.isFinite(price) || Math.abs(price - d.poPrice) <= d.poPrice * 0.01 + 0.00005
  return qtyOk && priceOk ? 'MATCHED' : priceOk ? 'QTY_OVER' : qtyOk ? 'PRICE_DIFF' : 'QTY_AND_PRICE'
}
