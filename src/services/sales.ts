import { supabase } from '@/lib/supabase'
import { sanitizeForOrFilter } from '@/lib/utils'
import type { PageParams, Paged, Tables } from '@/types/domain'
import { emptyToNull, rangeFor, unwrap, unwrapPaged } from './common'

export const INVOICE_STATUSES = ['DRAFT', 'POSTED', 'CANCELLED', 'REVERSED'] as const
export type SalesStatus = (typeof INVOICE_STATUSES)[number]
export const SALES_STATUS_LABEL: Record<SalesStatus, string> = { DRAFT: 'Draft', POSTED: 'Posted', CANCELLED: 'Cancelled', REVERSED: 'Reversed' }

export type SalesInvoice = Tables<'sales_invoices'> & {
  customer: { code: string; name: string } | null
  warehouse: { code: string; name: string } | null
}

const INV_SELECT =
  '*, customer:customers!sales_invoices_customer_fk(code, name), warehouse:warehouses!sales_invoices_warehouse_fk(code, name)'

export interface SalesListParams extends PageParams {
  search: string
  status: SalesStatus | ''
  customerId: string
  /** only invoices that still have a balance */
  unpaidOnly: boolean
}

export async function listSalesInvoices(p: SalesListParams): Promise<Paged<SalesInvoice>> {
  let q = supabase.from('sales_invoices').select(INV_SELECT, { count: 'exact' })
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.or(`invoice_number.ilike.%${s}%,customer_reference.ilike.%${s}%`)
  if (p.status) q = q.eq('status', p.status)
  if (p.customerId) q = q.eq('customer_id', p.customerId)
  if (p.unpaidOnly) q = q.eq('status', 'POSTED').gt('balance_due', 0)
  const [from, to] = rangeFor(p)
  const res = unwrapPaged(await q.order('created_at', { ascending: false }).order('id').range(from, to), 'sales.list', p)
  return { ...res, rows: res.rows as unknown as SalesInvoice[] }
}

export async function getSalesInvoice(id: string): Promise<SalesInvoice | null> {
  const res = await supabase.from('sales_invoices').select(INV_SELECT).eq('id', id).maybeSingle()
  return unwrap(res, 'sales.get') as unknown as SalesInvoice | null
}

export type SalesInvoiceLine = Tables<'sales_invoice_lines'> & {
  product: { sku: string; brand_name: string; product_class: string; base_unit: { code: string; name: string } | null } | null
  unit: { factor_to_base: number; unit: { code: string; name: string } | null } | null
}

export async function listSalesLines(invoiceId: string): Promise<SalesInvoiceLine[]> {
  const rows = unwrap(
    await supabase
      .from('sales_invoice_lines')
      .select('*, product:products!sales_invoice_lines_product_fk(sku, brand_name, product_class, base_unit:units_of_measure!products_base_unit_id_fkey(code, name)), unit:product_units!sales_invoice_lines_unit_fk(factor_to_base, unit:units_of_measure(code, name))')
      .eq('sales_invoice_id', invoiceId)
      .order('line_no'),
    'sales.lines',
  )
  return rows as unknown as SalesInvoiceLine[]
}

export type SalesAllocation = Tables<'sales_invoice_allocations'> & {
  batch: { batch_number: string; expiry_date: string } | null
  location: { code: string } | null
}

/** Which batches the goods came from (posted invoices only). */
export async function listSalesAllocations(invoiceId: string): Promise<SalesAllocation[]> {
  const rows = unwrap(
    await supabase
      .from('sales_invoice_allocations')
      .select('*, batch:batches!sales_invoice_allocations_batch_fk(batch_number, expiry_date), location:warehouse_locations(code)')
      .eq('sales_invoice_id', invoiceId)
      .order('sales_invoice_line_id'),
    'sales.allocations',
  )
  return rows as unknown as SalesAllocation[]
}

export interface SaveSalesLine {
  product_id: string
  quantity: number
  product_unit_id?: string
  unit_price?: number
  discount_percent?: number
}

export interface SaveSalesInput {
  id: string | null
  customerId: string
  warehouseId: string
  customerReference?: string
  notes?: string
  lines: SaveSalesLine[]
}

export async function saveSalesInvoice(i: SaveSalesInput): Promise<string> {
  return unwrap(
    await supabase.rpc('save_sales_invoice', {
      p_id: i.id as unknown as string, p_customer_id: i.customerId, p_warehouse_id: i.warehouseId,
      p_customer_reference: emptyToNull(i.customerReference) as unknown as string, p_notes: emptyToNull(i.notes) as unknown as string,
      p_lines: i.lines as unknown as never,
    }),
    'sales.save',
  ) as string
}

export interface PostPayment { amount: number; method: ReceiptMethod; reference?: string }
export interface PostResult { invoice_number: string; total_amount: number; stock_document_number: string; receipt_number: string | null; overridden: boolean }

export async function postSalesInvoice(id: string, overrideReason?: string, payment?: PostPayment): Promise<PostResult> {
  return unwrap(
    await supabase.rpc('post_sales_invoice', {
      p_id: id, p_override_reason: emptyToNull(overrideReason) ?? undefined, p_payment: (payment ?? undefined) as unknown as never,
    }),
    'sales.post',
  ) as unknown as PostResult
}

export async function reverseSalesInvoice(id: string, reason: string): Promise<{ stock_document_number: string; credit_released: number }> {
  const r = unwrap(await supabase.rpc('reverse_sales_invoice', { p_id: id, p_reason: reason }), 'sales.reverse') as unknown as { stock_document_number: string; credit_released: number }
  return { stock_document_number: r.stock_document_number, credit_released: Number(r.credit_released) }
}

export async function cancelSalesInvoice(id: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('cancel_sales_invoice', { p_id: id, p_reason: reason }), 'sales.cancel')
}

export type InvoicePayment = Tables<'receipt_allocations'> & {
  receipt: { receipt_number: string; method: string; reference: string | null; receipt_date: string; status: string } | null
}

/** The payments applied to one invoice (voided ones are left out). */
export async function listInvoicePayments(invoiceId: string): Promise<InvoicePayment[]> {
  const rows = unwrap(
    await supabase
      .from('receipt_allocations')
      .select('*, receipt:customer_receipts!receipt_allocations_receipt_fk(receipt_number, method, reference, receipt_date, status)')
      .eq('sales_invoice_id', invoiceId)
      .eq('is_voided', false)
      .order('created_at'),
    'sales.payments',
  )
  return rows as unknown as InvoicePayment[]
}

// ---- receipts ----------------------------------------------------------------------------------------------------------
export const RECEIPT_METHODS = ['CASH', 'MOBILE_MONEY', 'BANK_TRANSFER', 'CHEQUE', 'CARD'] as const
export type ReceiptMethod = (typeof RECEIPT_METHODS)[number]
export const RECEIPT_METHOD_LABEL: Record<ReceiptMethod, string> = {
  CASH: 'Cash', MOBILE_MONEY: 'Mobile money', BANK_TRANSFER: 'Bank transfer', CHEQUE: 'Cheque', CARD: 'Card',
}

export type CustomerReceipt = Tables<'customer_receipts'> & { customer: { code: string; name: string } | null }

export interface ReceiptListParams extends PageParams {
  search: string
  customerId: string
  status: 'POSTED' | 'VOID' | ''
}

export async function listReceipts(p: ReceiptListParams): Promise<Paged<CustomerReceipt>> {
  let q = supabase.from('customer_receipts').select('*, customer:customers!customer_receipts_customer_fk(code, name)', { count: 'exact' })
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.or(`receipt_number.ilike.%${s}%,reference.ilike.%${s}%`)
  if (p.customerId) q = q.eq('customer_id', p.customerId)
  if (p.status) q = q.eq('status', p.status)
  const [from, to] = rangeFor(p)
  const res = unwrapPaged(await q.order('created_at', { ascending: false }).order('id').range(from, to), 'receipts.list', p)
  return { ...res, rows: res.rows as unknown as CustomerReceipt[] }
}

export type ReceiptAllocation = Tables<'receipt_allocations'> & { invoice: { invoice_number: string | null } | null }

export async function listReceiptAllocations(receiptId: string): Promise<ReceiptAllocation[]> {
  const rows = unwrap(
    await supabase.from('receipt_allocations').select('*, invoice:sales_invoices!receipt_allocations_invoice_fk(invoice_number)').eq('receipt_id', receiptId).order('created_at'),
    'receipts.allocations',
  )
  return rows as unknown as ReceiptAllocation[]
}

/** A customer's posted invoices that still have something to pay, oldest due first. */
export async function listOpenInvoices(customerId: string): Promise<SalesInvoice[]> {
  const rows = unwrap(
    await supabase.from('sales_invoices').select(INV_SELECT).eq('customer_id', customerId).eq('status', 'POSTED').gt('balance_due', 0).order('due_date').order('posted_at').limit(200),
    'receipts.openInvoices',
  )
  return rows as unknown as SalesInvoice[]
}

export interface RecordReceiptInput {
  customerId: string
  branchId: string
  amount: number
  method: ReceiptMethod
  reference?: string
  /** null = oldest due first */
  allocations: { invoice_id: string; amount: number }[] | null
  notes?: string
}

export async function recordReceipt(i: RecordReceiptInput): Promise<{ receipt_number: string; allocated: number; unallocated: number }> {
  return unwrap(
    await supabase.rpc('record_receipt', {
      p_customer_id: i.customerId, p_branch_id: i.branchId, p_amount: i.amount, p_method: i.method, p_reference: emptyToNull(i.reference) ?? undefined,
      p_allocations: (i.allocations ?? undefined) as unknown as never, p_notes: emptyToNull(i.notes) ?? undefined,
    }),
    'receipts.record',
  ) as unknown as { receipt_number: string; allocated: number; unallocated: number }
}

export async function allocateReceipt(id: string): Promise<number> {
  const r = unwrap(await supabase.rpc('allocate_receipt', { p_receipt_id: id }), 'receipts.allocate') as unknown as { allocated: number }
  return Number(r.allocated)
}
export async function voidReceipt(id: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('void_receipt', { p_id: id, p_reason: reason }), 'receipts.void')
}

export interface ReceivablesRow {
  customer_id: string
  customer_name: string
  currency_code: string
  outstanding: number
  not_due: number
  overdue_1_30: number
  overdue_31_60: number
  overdue_61_90: number
  overdue_over_90: number
  credit_held: number
  credit_limit: number
  on_hold: boolean
}

export async function getReceivables(): Promise<ReceivablesRow[]> {
  const rows = unwrap(await supabase.rpc('receivables_summary'), 'receivables.summary')
  return rows.map((r) => ({
    customer_id: r.customer_id, customer_name: r.customer_name, currency_code: r.currency_code, outstanding: Number(r.outstanding), not_due: Number(r.not_due),
    overdue_1_30: Number(r.overdue_1_30), overdue_31_60: Number(r.overdue_31_60), overdue_61_90: Number(r.overdue_61_90), overdue_over_90: Number(r.overdue_over_90),
    credit_held: Number(r.credit_held), credit_limit: Number(r.credit_limit), on_hold: r.on_hold,
  }))
}

// ---- display / calculation helpers ------------------------------------------------------------------------------------------
export const moneyFmt = (n: number | string | null | undefined) => Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Round to cents the way numeric(18,2) does (half away from zero), ignoring binary floating-point noise. */
export const round2 = (x: number): number => Math.sign(x) * Math.round(Number((Math.abs(x) * 100).toPrecision(12))) / 100

/** The same arithmetic the database does, so the form's totals match what will be saved. */
export function computeLine(quantity: number, unitPrice: number, discountPercent: number, taxRate: number) {
  const gross = round2(quantity * unitPrice)
  const net = round2(quantity * unitPrice * (1 - discountPercent / 100))
  const tax = round2(net * taxRate / 100)
  return { gross, net, discount: round2(gross - net), tax, total: round2(net + tax) }
}
