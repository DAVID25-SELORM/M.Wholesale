import { supabase } from '@/lib/supabase'
import { sanitizeForOrFilter } from '@/lib/utils'
import type { PageParams, Paged, Tables } from '@/types/domain'
import { emptyToNull, rangeFor, unwrap, unwrapPaged } from './common'
import type { SaveSalesLine } from './sales'

// ---- quotations -----------------------------------------------------------------------------------------------------
export const QUOTATION_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'CANCELLED'] as const
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number]
export const QUOTATION_STATUS_LABEL: Record<QuotationStatus, string> = { DRAFT: 'Draft', SENT: 'Sent', ACCEPTED: 'Accepted', REJECTED: 'Rejected', CANCELLED: 'Cancelled' }

export type Quotation = Tables<'sales_quotations'> & {
  customer: { code: string; name: string } | null
  warehouse: { code: string; name: string } | null
  order: { order_number: string | null } | null
}

const QUOTE_SELECT =
  '*, customer:customers!sales_quotations_customer_fk(code, name), warehouse:warehouses!sales_quotations_warehouse_fk(code, name), order:sales_orders!sales_quotations_order_fk(order_number)'

export interface QuotationListParams extends PageParams {
  search: string
  status: QuotationStatus | ''
  customerId: string
}

export async function listQuotations(p: QuotationListParams): Promise<Paged<Quotation>> {
  let q = supabase.from('sales_quotations').select(QUOTE_SELECT, { count: 'exact' })
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.or(`quotation_number.ilike.%${s}%,customer_reference.ilike.%${s}%`)
  if (p.status) q = q.eq('status', p.status)
  if (p.customerId) q = q.eq('customer_id', p.customerId)
  const [from, to] = rangeFor(p)
  const res = unwrapPaged(await q.order('created_at', { ascending: false }).order('id').range(from, to), 'quotations.list', p)
  return { ...res, rows: res.rows as unknown as Quotation[] }
}

export async function getQuotation(id: string): Promise<Quotation | null> {
  const res = await supabase.from('sales_quotations').select(QUOTE_SELECT).eq('id', id).maybeSingle()
  return unwrap(res, 'quotations.get') as unknown as Quotation | null
}

/** Lines of a quotation or an order, with the product and pack they are priced in. */
export interface DocLine {
  id: string
  line_no: number
  product_id: string
  product_unit_id: string
  quantity: number
  base_quantity: number
  list_price: number | null
  unit_price: number
  discount_percent: number
  tax_rate: number
  line_net: number
  line_tax: number
  line_total: number
  product: { sku: string; brand_name: string; product_class: string; base_unit: { code: string; name: string } | null } | null
  unit: { factor_to_base: number; unit: { code: string; name: string } | null } | null
}

const LINE_SELECT = (fk: string) =>
  `*, product:products!${fk}_product_fk(sku, brand_name, product_class, base_unit:units_of_measure!products_base_unit_id_fkey(code, name)), unit:product_units!${fk}_unit_fk(factor_to_base, unit:units_of_measure(code, name))`

export async function listQuotationLines(id: string): Promise<DocLine[]> {
  const rows = unwrap(await supabase.from('sales_quotation_lines').select(LINE_SELECT('sales_quotation_lines')).eq('quotation_id', id).order('line_no'), 'quotations.lines')
  return rows as unknown as DocLine[]
}

export async function saveQuotation(i: {
  id: string | null; customerId: string; warehouseId: string; validUntil: string; customerReference?: string; notes?: string; lines: SaveSalesLine[]
}): Promise<string> {
  return unwrap(
    await supabase.rpc('save_quotation', {
      p_id: i.id as unknown as string, p_customer_id: i.customerId, p_warehouse_id: i.warehouseId, p_valid_until: i.validUntil,
      p_customer_reference: emptyToNull(i.customerReference) as unknown as string, p_notes: emptyToNull(i.notes) as unknown as string, p_lines: i.lines as unknown as never,
    }),
    'quotations.save',
  ) as string
}
export async function sendQuotation(id: string): Promise<string> {
  return unwrap(await supabase.rpc('send_quotation', { p_id: id }), 'quotations.send') as string
}
export async function rejectQuotation(id: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('reject_quotation', { p_id: id, p_reason: reason }), 'quotations.reject')
}
export async function cancelQuotation(id: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('cancel_quotation', { p_id: id, p_reason: reason }), 'quotations.cancel')
}
export async function convertQuotation(id: string): Promise<string> {
  return unwrap(await supabase.rpc('convert_quotation_to_order', { p_id: id }), 'quotations.convert') as string
}

// ---- orders ---------------------------------------------------------------------------------------------------------
export const ORDER_STATUSES = ['DRAFT', 'CONFIRMED', 'COMPLETED', 'CLOSED', 'CANCELLED'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = { DRAFT: 'Draft', CONFIRMED: 'Confirmed', COMPLETED: 'Completed', CLOSED: 'Closed short', CANCELLED: 'Cancelled' }

export type SalesOrder = Tables<'sales_orders'> & {
  customer: { code: string; name: string } | null
  warehouse: { code: string; name: string } | null
  quotation: { quotation_number: string | null } | null
}

const ORDER_SELECT =
  '*, customer:customers!sales_orders_customer_fk(code, name), warehouse:warehouses!sales_orders_warehouse_fk(code, name), quotation:sales_quotations!sales_orders_quotation_fk(quotation_number)'

export interface OrderListParams extends PageParams {
  search: string
  status: OrderStatus | ''
  customerId: string
  /** only orders still holding stock for the customer */
  openOnly: boolean
}

export async function listSalesOrders(p: OrderListParams): Promise<Paged<SalesOrder>> {
  let q = supabase.from('sales_orders').select(ORDER_SELECT, { count: 'exact' })
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.or(`order_number.ilike.%${s}%,customer_reference.ilike.%${s}%`)
  if (p.status) q = q.eq('status', p.status)
  if (p.customerId) q = q.eq('customer_id', p.customerId)
  if (p.openOnly) q = q.eq('status', 'CONFIRMED')
  const [from, to] = rangeFor(p)
  const res = unwrapPaged(await q.order('created_at', { ascending: false }).order('id').range(from, to), 'orders.list', p)
  return { ...res, rows: res.rows as unknown as SalesOrder[] }
}

export async function getSalesOrder(id: string): Promise<SalesOrder | null> {
  const res = await supabase.from('sales_orders').select(ORDER_SELECT).eq('id', id).maybeSingle()
  return unwrap(res, 'orders.get') as unknown as SalesOrder | null
}

export async function listOrderLines(id: string): Promise<DocLine[]> {
  const rows = unwrap(await supabase.from('sales_order_lines').select(LINE_SELECT('sales_order_lines')).eq('sales_order_id', id).order('line_no'), 'orders.lines')
  return rows as unknown as DocLine[]
}

export interface OrderProgress { order_line_id: string; line_no: number; quantity: number; invoiced: number; in_draft: number; remaining: number; reserved_base: number }

export async function getOrderProgress(orderId: string): Promise<OrderProgress[]> {
  const rows = unwrap(await supabase.rpc('order_progress', { p_order_id: orderId }), 'orders.progress')
  return rows.map((r) => ({
    order_line_id: r.order_line_id, line_no: r.line_no, quantity: Number(r.quantity), invoiced: Number(r.invoiced), in_draft: Number(r.in_draft),
    remaining: Number(r.remaining), reserved_base: Number(r.reserved_base),
  }))
}

export async function saveSalesOrder(i: {
  id: string | null; customerId: string; warehouseId: string; requiredDate?: string; reservedUntil?: string; customerReference?: string; notes?: string; lines: SaveSalesLine[]
}): Promise<string> {
  return unwrap(
    await supabase.rpc('save_sales_order', {
      p_id: i.id as unknown as string, p_customer_id: i.customerId, p_warehouse_id: i.warehouseId, p_required_date: emptyToNull(i.requiredDate) as unknown as string,
      p_reserved_until: emptyToNull(i.reservedUntil) as unknown as string, p_customer_reference: emptyToNull(i.customerReference) as unknown as string,
      p_notes: emptyToNull(i.notes) as unknown as string, p_lines: i.lines as unknown as never,
    }),
    'orders.save',
  ) as string
}
export async function confirmSalesOrder(id: string): Promise<string> {
  return (unwrap(await supabase.rpc('confirm_sales_order', { p_id: id }), 'orders.confirm') as unknown as { order_number: string }).order_number
}
export async function cancelSalesOrder(id: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('cancel_sales_order', { p_id: id, p_reason: reason }), 'orders.cancel')
}
export async function closeSalesOrder(id: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('close_sales_order', { p_id: id, p_reason: reason }), 'orders.close')
}
/** Creates a draft invoice at the order's prices: the chosen quantities, or everything left. */
export async function invoiceSalesOrder(id: string, lines?: { order_line_id: string; quantity: number }[]): Promise<string> {
  return unwrap(await supabase.rpc('invoice_sales_order', { p_order_id: id, p_lines: (lines ?? undefined) as unknown as never }), 'orders.invoice') as string
}

export interface StockAvailability { on_hand: number; reserved: number; free: number }

export async function getStockAvailability(warehouseId: string, productId: string): Promise<StockAvailability> {
  const rows = unwrap(await supabase.rpc('stock_availability', { p_warehouse_id: warehouseId, p_product_id: productId }), 'orders.availability')
  const r = rows[0]
  return { on_hand: Number(r?.on_hand ?? 0), reserved: Number(r?.reserved ?? 0), free: Number(r?.free ?? 0) }
}

/** The invoices raised from one order. */
export async function listOrderInvoices(orderId: string): Promise<{ id: string; invoice_number: string | null; status: string; total_amount: number; balance_due: number | null }[]> {
  return unwrap(
    await supabase.from('sales_invoices').select('id, invoice_number, status, total_amount, balance_due').eq('sales_order_id', orderId).order('created_at'),
    'orders.invoices',
  )
}
