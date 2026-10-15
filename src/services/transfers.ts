import { supabase } from '@/lib/supabase'
import type { PageParams, Paged, Tables } from '@/types/domain'
import { rangeFor, unwrap, unwrapPaged } from './common'
import type { StockStatus } from './inventory'

export const TRANSFER_STATUSES = ['IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'] as const
export type TransferStatus = (typeof TRANSFER_STATUSES)[number]
export const TRANSFER_STATUS_LABEL: Record<TransferStatus, string> = {
  IN_TRANSIT: 'On the way', PARTIALLY_RECEIVED: 'Partly received', RECEIVED: 'Received', CLOSED: 'Closed short', CANCELLED: 'Cancelled',
}
export const TRANSFER_STATUS_TONE: Record<TransferStatus, 'blue' | 'purple' | 'green' | 'amber' | 'red'> = {
  IN_TRANSIT: 'blue', PARTIALLY_RECEIVED: 'purple', RECEIVED: 'green', CLOSED: 'amber', CANCELLED: 'red',
}

export type StockTransfer = Tables<'stock_transfers'> & {
  from_warehouse: { code: string; name: string } | null
  to_warehouse: { code: string; name: string } | null
}

const T_SELECT =
  '*, from_warehouse:warehouses!stock_transfers_from_wh_fk(code, name), to_warehouse:warehouses!stock_transfers_to_wh_fk(code, name)'

export interface TransferListParams extends PageParams {
  status: TransferStatus | ''
  /** only transfers that are still on their way */
  openOnly: boolean
}

export async function listStockTransfers(p: TransferListParams): Promise<Paged<StockTransfer>> {
  let q = supabase.from('stock_transfers').select(T_SELECT, { count: 'exact' })
  if (p.openOnly) q = q.in('status', ['IN_TRANSIT', 'PARTIALLY_RECEIVED'])
  else if (p.status) q = q.eq('status', p.status)
  const [from, to] = rangeFor(p)
  const res = unwrapPaged(await q.order('dispatched_at', { ascending: false }).order('id').range(from, to), 'transfers.list', p)
  return { ...res, rows: res.rows as unknown as StockTransfer[] }
}

export type StockTransferLine = Tables<'stock_transfer_lines'> & {
  product: { sku: string; brand_name: string; base_unit: { code: string; name: string } | null } | null
  batch: { batch_number: string; expiry_date: string } | null
  location: { code: string } | null
  source_status: StockStatus
}

export async function listTransferLines(transferId: string): Promise<StockTransferLine[]> {
  const rows = unwrap(
    await supabase
      .from('stock_transfer_lines')
      .select('*, product:products!stock_transfer_lines_product_fk(sku, brand_name, base_unit:units_of_measure!products_base_unit_id_fkey(code, name)), batch:batches!stock_transfer_lines_batch_fk(batch_number, expiry_date), location:warehouse_locations(code)')
      .eq('stock_transfer_id', transferId)
      .order('line_no'),
    'transfers.lines',
  )
  return rows as unknown as StockTransferLine[]
}

/** Base units of a line that have neither arrived, been written off nor been sent back. */
export const outstandingBase = (l: Pick<StockTransferLine, 'dispatched_base' | 'received_base' | 'short_base' | 'returned_base'>): number =>
  Math.round((Number(l.dispatched_base) - Number(l.received_base) - Number(l.short_base) - Number(l.returned_base)) * 1000) / 1000

export interface DispatchLine {
  product_id: string
  quantity: number
  batch_id?: string
  product_unit_id?: string
  location_id?: string
  status?: StockStatus
}

export async function dispatchTransfer(fromWarehouseId: string, toWarehouseId: string, lines: DispatchLine[], notes?: string): Promise<{ transfer_number: string }> {
  return unwrap(
    await supabase.rpc('dispatch_transfer', {
      p_from_warehouse_id: fromWarehouseId, p_to_warehouse_id: toWarehouseId, p_lines: lines as unknown as never, p_notes: notes?.trim() || undefined,
    }),
    'transfers.dispatch',
  ) as unknown as { transfer_number: string }
}

export interface ReceiveTransferLine {
  line_id: string
  quantity: number
  product_unit_id?: string
  status?: StockStatus
  location_id?: string
}

export async function receiveTransfer(id: string, lines: ReceiveTransferLine[], notes?: string): Promise<{ transfer_status: TransferStatus }> {
  return unwrap(
    await supabase.rpc('receive_transfer', { p_id: id, p_lines: lines as unknown as never, p_notes: notes?.trim() || undefined }),
    'transfers.receive',
  ) as unknown as { transfer_status: TransferStatus }
}
export async function closeTransfer(id: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('close_transfer', { p_id: id, p_reason: reason }), 'transfers.close')
}
export async function cancelTransfer(id: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('cancel_transfer', { p_id: id, p_reason: reason }), 'transfers.cancel')
}
