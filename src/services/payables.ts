import { supabase } from '@/lib/supabase'
import { sanitizeForOrFilter } from '@/lib/utils'
import type { PageParams, Paged, Tables } from '@/types/domain'
import { emptyToNull, rangeFor, unwrap, unwrapPaged } from './common'
import type { PurchaseOrderLine } from './purchasing'

export const INVOICE_STATUSES = ['MATCHED', 'EXCEPTION', 'APPROVED', 'PAID', 'CANCELLED'] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]
export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  MATCHED: 'Matched', EXCEPTION: 'Mismatch', APPROVED: 'Approved to pay', PAID: 'Paid', CANCELLED: 'Cancelled',
}
export const INVOICE_STATUS_TONE: Record<InvoiceStatus, 'green' | 'amber' | 'blue' | 'slate' | 'red'> = {
  MATCHED: 'green', EXCEPTION: 'amber', APPROVED: 'blue', PAID: 'slate', CANCELLED: 'red',
}
export type MatchStatus = 'MATCHED' | 'QTY_OVER' | 'PRICE_DIFF' | 'QTY_AND_PRICE'
export const MATCH_LABEL: Record<MatchStatus, string> = {
  MATCHED: 'Matches', QTY_OVER: 'More than received', PRICE_DIFF: 'Price differs', QTY_AND_PRICE: 'Quantity and price differ',
}

export type SupplierInvoice = Tables<'supplier_invoices'> & {
  supplier: { code: string; name: string } | null
  purchase_order: { po_number: string } | null
}

const INV_SELECT =
  '*, supplier:suppliers!supplier_invoices_supplier_fk(code, name), purchase_order:purchase_orders!supplier_invoices_po_fk(po_number)'

export interface InvoiceListParams extends PageParams {
  search: string
  status: InvoiceStatus | ''
  supplierId: string
}

export async function listSupplierInvoices(p: InvoiceListParams): Promise<Paged<SupplierInvoice>> {
  let q = supabase.from('supplier_invoices').select(INV_SELECT, { count: 'exact' })
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.or(`invoice_number.ilike.%${s}%,supplier_invoice_number.ilike.%${s}%`)
  if (p.status) q = q.eq('status', p.status)
  if (p.supplierId) q = q.eq('supplier_id', p.supplierId)
  const [from, to] = rangeFor(p)
  const res = unwrapPaged(await q.order('created_at', { ascending: false }).order('id').range(from, to), 'supplierInvoices.list', p)
  return { ...res, rows: res.rows as unknown as SupplierInvoice[] }
}

export async function getSupplierInvoice(id: string): Promise<SupplierInvoice | null> {
  const res = await supabase.from('supplier_invoices').select(INV_SELECT).eq('id', id).maybeSingle()
  return unwrap(res, 'supplierInvoices.get') as unknown as SupplierInvoice | null
}

export type SupplierInvoiceLine = Tables<'supplier_invoice_lines'> & {
  product: { sku: string; brand_name: string } | null
  po_line: { unit: { unit: { code: string; name: string } | null } | null } | null
}

export async function listInvoiceLines(invoiceId: string): Promise<SupplierInvoiceLine[]> {
  const rows = unwrap(
    await supabase
      .from('supplier_invoice_lines')
      .select('*, product:products!supplier_invoice_lines_product_fk(sku, brand_name), po_line:purchase_order_lines!supplier_invoice_lines_po_line_fk(unit:product_units!purchase_order_lines_unit_fk(unit:units_of_measure(code, name)))')
      .eq('supplier_invoice_id', invoiceId)
      .order('line_no'),
    'supplierInvoices.lines',
  )
  return rows as unknown as SupplierInvoiceLine[]
}

export interface InvoiceLineInput { po_line_id: string; quantity: number; unit_price: number }

export interface RecordInvoiceInput {
  id: string | null
  purchaseOrderId: string
  supplierInvoiceNumber: string
  invoiceDate: string
  taxAmount: number
  notes?: string
  lines: InvoiceLineInput[]
}

export async function recordSupplierInvoice(i: RecordInvoiceInput): Promise<string> {
  return unwrap(
    await supabase.rpc('record_supplier_invoice', {
      p_id: i.id as unknown as string, p_purchase_order_id: i.purchaseOrderId, p_supplier_invoice_number: i.supplierInvoiceNumber,
      p_invoice_date: i.invoiceDate, p_tax_amount: i.taxAmount, p_notes: emptyToNull(i.notes) as unknown as string,
      p_lines: i.lines as unknown as never,
    }),
    'supplierInvoices.record',
  ) as string
}

export async function approveSupplierInvoice(id: string, varianceReason?: string): Promise<void> {
  unwrap(await supabase.rpc('approve_supplier_invoice', { p_id: id, p_variance_reason: emptyToNull(varianceReason) ?? undefined }), 'supplierInvoices.approve')
}
export async function cancelSupplierInvoice(id: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('cancel_supplier_invoice', { p_id: id, p_reason: reason }), 'supplierInvoices.cancel')
}
export async function paySupplierInvoice(id: string, paidOn: string, reference: string): Promise<void> {
  unwrap(await supabase.rpc('pay_supplier_invoice', { p_id: id, p_paid_on: paidOn, p_reference: reference }), 'supplierInvoices.pay')
}

export interface PayablesRow {
  supplier_id: string
  supplier_name: string
  currency_code: string
  outstanding: number
  not_due: number
  overdue_1_30: number
  overdue_31_60: number
  overdue_61_90: number
  overdue_over_90: number
  awaiting_approval: number
  credit_expected: number
}

export async function getPayablesSummary(): Promise<PayablesRow[]> {
  const rows = unwrap(await supabase.rpc('payables_summary'), 'payables.summary')
  return rows.map((r) => ({
    supplier_id: r.supplier_id, supplier_name: r.supplier_name, currency_code: r.currency_code,
    outstanding: Number(r.outstanding), not_due: Number(r.not_due), overdue_1_30: Number(r.overdue_1_30),
    overdue_31_60: Number(r.overdue_31_60), overdue_61_90: Number(r.overdue_61_90), overdue_over_90: Number(r.overdue_over_90),
    awaiting_approval: Number(r.awaiting_approval), credit_expected: Number(r.credit_expected),
  }))
}

// ---- what can still be invoiced on an order (for pre-filling the form; the database re-checks) -------------------------
export interface BillableLine {
  line: PurchaseOrderLine
  receivedPacks: number
  billedPacks: number
  allowedPacks: number
}

export async function listBillableLines(lines: PurchaseOrderLine[]): Promise<BillableLine[]> {
  if (lines.length === 0) return []
  const billed = unwrap(
    await supabase
      .from('supplier_invoice_lines')
      .select('po_line_id, quantity, invoice:supplier_invoices!supplier_invoice_lines_invoice_fk(status)')
      .in('po_line_id', lines.map((l) => l.id)),
    'supplierInvoices.billed',
  ) as unknown as { po_line_id: string; quantity: number; invoice: { status: string } | null }[]
  return lines.map((l) => {
    const ordered = Number(l.ordered_base)
    const receivedPacks = ordered > 0 ? Math.round((Number(l.received_base) / ordered) * Number(l.quantity_ordered) * 1000) / 1000 : 0
    const billedPacks = billed.filter((b) => b.po_line_id === l.id && b.invoice?.status !== 'CANCELLED').reduce((s, b) => s + Number(b.quantity), 0)
    return { line: l, receivedPacks, billedPacks, allowedPacks: Math.max(0, Math.round((receivedPacks - billedPacks) * 1000) / 1000) }
  })
}
