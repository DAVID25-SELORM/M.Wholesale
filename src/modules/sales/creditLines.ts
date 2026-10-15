import type { Creditable, ReturnCondition, SaveCreditLine } from '@/services/creditNotes'
import { round2 } from '@/services/sales'

/** What the credit note form needs to know about one invoice line. */
export interface InvoiceLineInfo {
  id: string
  lineNo: number
  label: string
  unitPrice: number
  discountPercent: number
  taxRate: number
  creditable: Creditable
}

/** One row of the form: goods to take back and/or a value-only correction on one invoice line. */
export interface CreditLineDraft {
  invoiceLineId: string
  returnQty: string
  condition: ReturnCondition
  batchId: string
  priceAmount: string
  priceNote: string
}

export const emptyCreditDraft = (invoiceLineId: string): CreditLineDraft => ({
  invoiceLineId, returnQty: '', condition: 'QUARANTINE', batchId: '', priceAmount: '', priceNote: '',
})

export type CreditLinesResult =
  | { ok: true; lines: SaveCreditLine[]; subtotal: number; tax: number; total: number; perLine: Record<string, number> }
  | { ok: false; error: string }

export interface CreditRights { canRestock: boolean }

/** Validates and values the rows the way the database will (it re-checks everything; this keeps the form honest). */
export function buildCreditLines(drafts: CreditLineDraft[], infos: InvoiceLineInfo[], rights: CreditRights): CreditLinesResult {
  const lines: SaveCreditLine[] = []
  const perLine: Record<string, number> = {}
  let subtotal = 0
  let tax = 0
  for (const d of drafts) {
    const info = infos.find((i) => i.id === d.invoiceLineId)
    if (!info) continue
    const fail = (m: string): CreditLinesResult => ({ ok: false, error: `Line ${info.lineNo} (${info.label}): ${m}` })
    const c = info.creditable
    let remNet = c.remaining_net
    let remTax = c.remaining_tax
    let value = 0

    if (d.returnQty.trim() !== '') {
      const qty = Number(d.returnQty)
      if (!Number.isFinite(qty) || qty <= 0) return fail('enter a quantity to return greater than 0.')
      if (Math.abs(qty - Number(qty.toFixed(3))) > 1e-9) return fail('the quantity can have at most 3 decimals.')
      if (qty > c.remaining_quantity + 1e-9) return fail(`only ${c.remaining_quantity} can still be returned.`)
      if (d.condition === 'AVAILABLE' && !rights.canRestock) return fail('you are not allowed to return goods straight into sellable stock.')
      let net: number
      let t: number
      if (Math.abs(qty - c.remaining_quantity) < 1e-9) {
        net = remNet
        t = remTax
      } else {
        net = Math.min(remNet, round2(qty * info.unitPrice * (1 - info.discountPercent / 100)))
        t = Math.min(remTax, round2(net * info.taxRate / 100))
      }
      remNet = round2(remNet - net)
      remTax = round2(remTax - t)
      subtotal += net
      tax += t
      value += net + t
      lines.push({ type: 'RETURN', invoice_line_id: info.id, quantity: qty, condition: d.condition, ...(d.batchId ? { batch_id: d.batchId } : {}) })
    }

    if (d.priceAmount.trim() !== '') {
      const amount = Number(d.priceAmount)
      if (!Number.isFinite(amount) || amount <= 0) return fail('enter a price correction greater than 0.')
      if (Math.abs(amount - round2(amount)) > 1e-9) return fail('the price correction can have at most 2 decimals.')
      if (amount > remNet + 1e-9) return fail(`only ${round2(remNet)} can still be credited on this line.`)
      const t = Math.abs(amount - remNet) < 1e-9 ? remTax : Math.min(remTax, round2(amount * info.taxRate / 100))
      subtotal += amount
      tax += t
      value += amount + t
      lines.push({ type: 'PRICE', invoice_line_id: info.id, amount, ...(d.priceNote.trim() ? { description: d.priceNote.trim() } : {}) })
    }
    if (value > 0) perLine[info.id] = round2(value)
  }
  if (lines.length === 0) return { ok: false, error: 'Enter a quantity to return or a price correction on at least one line.' }
  return { ok: true, lines, subtotal: round2(subtotal), tax: round2(tax), total: round2(subtotal + tax), perLine }
}

/** Turns saved credit note lines back into form rows (for editing a draft). */
export function draftsFromLines(
  saved: { line_type: string; invoice_line_id: string; quantity: number | null; return_condition: string | null; batch_id: string | null; description: string | null; line_net: number }[],
  infos: InvoiceLineInfo[],
): CreditLineDraft[] {
  const rows = new Map<string, CreditLineDraft>(infos.map((i) => [i.id, emptyCreditDraft(i.id)]))
  for (const l of saved) {
    const row = rows.get(l.invoice_line_id)
    if (!row) continue
    if (l.line_type === 'RETURN') {
      row.returnQty = String(Number(l.quantity))
      row.condition = (l.return_condition as ReturnCondition) ?? 'QUARANTINE'
      row.batchId = l.batch_id ?? ''
    } else {
      row.priceAmount = String(Number(l.line_net))
      row.priceNote = l.description ?? ''
    }
  }
  return [...rows.values()]
}
