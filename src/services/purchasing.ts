import { supabase } from '@/lib/supabase'
import { sanitizeForOrFilter } from '@/lib/utils'
import type { PageParams, Paged, Tables } from '@/types/domain'
import { emptyToNull, rangeFor, unwrap, unwrapPaged } from './common'

export const PO_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'] as const
export type PoStatus = (typeof PO_STATUSES)[number]
export const PO_STATUS_LABEL: Record<PoStatus, string> = {
  DRAFT: 'Draft', SUBMITTED: 'Awaiting approval', APPROVED: 'Approved', PARTIALLY_RECEIVED: 'Partly received',
  RECEIVED: 'Received', CLOSED: 'Closed', CANCELLED: 'Cancelled',
}
export const PO_STATUS_TONE: Record<PoStatus, 'slate' | 'amber' | 'blue' | 'purple' | 'green' | 'red'> = {
  DRAFT: 'slate', SUBMITTED: 'amber', APPROVED: 'blue', PARTIALLY_RECEIVED: 'purple', RECEIVED: 'green', CLOSED: 'slate', CANCELLED: 'red',
}

export type ReceiptStatus = 'AVAILABLE' | 'QUARANTINE' | 'DAMAGED'
export const RECEIPT_STATUS_LABEL: Record<ReceiptStatus, string> = {
  AVAILABLE: 'Available (good)', QUARANTINE: 'Quarantine (hold)', DAMAGED: 'Damaged on arrival',
}

// ---- reads ---------------------------------------------------------------------------------------------------
export type PurchaseOrder = Tables<'purchase_orders'> & {
  supplier: { code: string; name: string } | null
  warehouse: { code: string; name: string } | null
}

const PO_SELECT = '*, supplier:suppliers!purchase_orders_supplier_fk(code, name), warehouse:warehouses!purchase_orders_warehouse_fk(code, name)'

export interface PurchaseOrderListParams extends PageParams {
  search: string
  status: PoStatus | ''
  supplierId: string
}

export async function listPurchaseOrders(p: PurchaseOrderListParams): Promise<Paged<PurchaseOrder>> {
  let q = supabase.from('purchase_orders').select(PO_SELECT, { count: 'exact' })
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.ilike('po_number', `%${s}%`)
  if (p.status) q = q.eq('status', p.status)
  if (p.supplierId) q = q.eq('supplier_id', p.supplierId)
  const [from, to] = rangeFor(p)
  const res = unwrapPaged(await q.order('created_at', { ascending: false }).order('id').range(from, to), 'purchaseOrders.list', p)
  return { ...res, rows: res.rows as unknown as PurchaseOrder[] }
}

export async function getPurchaseOrder(id: string): Promise<PurchaseOrder | null> {
  const res = await supabase.from('purchase_orders').select(PO_SELECT).eq('id', id).maybeSingle()
  return unwrap(res, 'purchaseOrders.get') as unknown as PurchaseOrder | null
}

export type PurchaseOrderLine = Tables<'purchase_order_lines'> & {
  product: { sku: string; brand_name: string; track_batches: boolean } | null
  unit: { factor_to_base: number; unit: { code: string; name: string } | null } | null
}

const POL_SELECT =
  '*, product:products!purchase_order_lines_product_fk(sku, brand_name, track_batches), unit:product_units!purchase_order_lines_unit_fk(factor_to_base, unit:units_of_measure(code, name))'

export async function listPurchaseOrderLines(poId: string): Promise<PurchaseOrderLine[]> {
  const rows = unwrap(await supabase.from('purchase_order_lines').select(POL_SELECT).eq('purchase_order_id', poId).order('line_no'), 'purchaseOrders.lines')
  return rows as unknown as PurchaseOrderLine[]
}

export type GoodsReceipt = Tables<'goods_receipts'> & {
  purchase_order: { po_number: string } | null
  supplier: { code: string; name: string } | null
  warehouse: { code: string; name: string } | null
}

const GRN_SELECT =
  '*, purchase_order:purchase_orders!goods_receipts_po_fk(po_number), supplier:suppliers!goods_receipts_supplier_fk(code, name), warehouse:warehouses!goods_receipts_warehouse_fk(code, name)'

export interface ReceiptListParams extends PageParams {
  purchaseOrderId: string
  search: string
}

export async function listGoodsReceipts(p: ReceiptListParams): Promise<Paged<GoodsReceipt>> {
  let q = supabase.from('goods_receipts').select(GRN_SELECT, { count: 'exact' })
  if (p.purchaseOrderId) q = q.eq('purchase_order_id', p.purchaseOrderId)
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.or(`grn_number.ilike.%${s}%,delivery_note.ilike.%${s}%`)
  const [from, to] = rangeFor(p)
  const res = unwrapPaged(await q.order('received_at', { ascending: false }).order('id').range(from, to), 'goodsReceipts.list', p)
  return { ...res, rows: res.rows as unknown as GoodsReceipt[] }
}

export type GoodsReceiptLine = Tables<'goods_receipt_lines'> & {
  product: { sku: string; brand_name: string } | null
  batch: { batch_number: string; expiry_date: string } | null
  unit: { unit: { code: string; name: string } | null } | null
  location: { code: string } | null
}

export async function listReceiptLines(receiptId: string): Promise<GoodsReceiptLine[]> {
  const rows = unwrap(
    await supabase
      .from('goods_receipt_lines')
      .select('*, product:products!goods_receipt_lines_product_fk(sku, brand_name), batch:batches!goods_receipt_lines_batch_fk(batch_number, expiry_date), unit:product_units!goods_receipt_lines_unit_fk(unit:units_of_measure(code, name)), location:warehouse_locations(code)')
      .eq('goods_receipt_id', receiptId)
      .order('line_no'),
    'goodsReceipts.lines',
  )
  return rows as unknown as GoodsReceiptLine[]
}

// ---- writes (all through database functions) --------------------------------------------------------------------
export interface SaveOrderLine { product_id: string; quantity: number; unit_cost: number; product_unit_id?: string }

export interface SaveOrderInput {
  id: string | null
  supplierId: string
  warehouseId: string
  expectedDate?: string | undefined
  paymentTermsDays?: number | undefined
  notes?: string | undefined
  lines: SaveOrderLine[]
}

// The database function takes these three as NULL when absent; the generated types only know "string".
const nullable = (v: string | null): string => v as unknown as string

export async function savePurchaseOrder(i: SaveOrderInput): Promise<string> {
  return unwrap(
    await supabase.rpc('save_purchase_order', {
      p_id: nullable(i.id), p_supplier_id: i.supplierId, p_warehouse_id: i.warehouseId,
      p_expected_date: nullable(emptyToNull(i.expectedDate)), p_notes: nullable(emptyToNull(i.notes)),
      p_lines: i.lines as unknown as never, p_payment_terms_days: i.paymentTermsDays,
    }),
    'purchaseOrders.save',
  ) as string
}

export async function submitPurchaseOrder(id: string): Promise<void> {
  unwrap(await supabase.rpc('submit_purchase_order', { p_id: id }), 'purchaseOrders.submit')
}
export async function approvePurchaseOrder(id: string): Promise<void> {
  unwrap(await supabase.rpc('approve_purchase_order', { p_id: id }), 'purchaseOrders.approve')
}
export async function rejectPurchaseOrder(id: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('reject_purchase_order', { p_id: id, p_reason: reason }), 'purchaseOrders.reject')
}
export async function cancelPurchaseOrder(id: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('cancel_purchase_order', { p_id: id, p_reason: reason }), 'purchaseOrders.cancel')
}
export async function closePurchaseOrder(id: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('close_purchase_order', { p_id: id, p_reason: reason }), 'purchaseOrders.close')
}

export interface ReceiveLine {
  po_line_id: string
  quantity: number
  product_unit_id?: string
  batch_number?: string
  expiry_date?: string
  manufacture_date?: string
  location_id?: string
  status?: ReceiptStatus
}

export interface ReceiveResult { goods_receipt_id: string; grn_number: string; stock_document_number: string; order_status: PoStatus }

export async function receiveGoods(poId: string, lines: ReceiveLine[], deliveryNote?: string, notes?: string): Promise<ReceiveResult> {
  return unwrap(
    await supabase.rpc('receive_goods', {
      p_purchase_order_id: poId, p_lines: lines as unknown as never,
      p_delivery_note: emptyToNull(deliveryNote) ?? undefined, p_notes: emptyToNull(notes) ?? undefined,
    }),
    'goods.receive',
  ) as unknown as ReceiveResult
}

// ---- display helpers -------------------------------------------------------------------------------------------
export const money = (n: number | string, currency: string) =>
  `${currency} ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** How much of a line is still expected, in the pack level it was ordered in. */
export function remainingPacks(l: Pick<PurchaseOrderLine, 'ordered_base' | 'received_base' | 'quantity_ordered'>): number {
  const ordered = Number(l.ordered_base)
  if (ordered <= 0) return 0
  return Math.max(0, Math.round(((ordered - Number(l.received_base)) / ordered) * Number(l.quantity_ordered) * 1000) / 1000)
}
