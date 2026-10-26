import { supabase } from '@/lib/supabase'
import type { Tables } from '@/types/domain'
import { emptyToNull, unwrap } from './common'

export type FulfilmentOrder = Tables<'fulfilment_orders'>
export const FULFILMENT_STATUS_LABEL: Record<string, string> = {
  RELEASED: 'Waiting to pick', PICKING: 'Being picked', PICKED: 'Picked', HOLD: 'On hold', PACKING: 'Packing', PACKED: 'Packed', READY: 'Ready to ship', CANCELLED: 'Cancelled',
}
export const PRIORITY_LABEL: Record<number, string> = { 1: 'Urgent', 2: 'Normal', 3: 'Low' }
export const SHORT_REASONS = [
  { value: 'NOT_FOUND', label: 'Not found on the shelf' }, { value: 'DAMAGED', label: 'Damaged' }, { value: 'EXPIRED', label: 'Expired' }, { value: 'OTHER', label: 'Other (explain)' },
] as const
export type ShortReason = (typeof SHORT_REASONS)[number]['value']

export interface QueueRow {
  id: string; order_number: string; status: string; priority: number; required_by: string | null; released_at: string; branch_id: string; branch_name: string; warehouse_name: string
  invoice_id: string; invoice_number: string | null; customer_name: string; picker_id: string | null; picker_name: string | null; line_count: number; lines_done: number; open_exceptions: number
}

export interface PickListLine {
  line_id: string; line_no: number; status: 'PENDING' | 'PICKED' | 'SHORT'; sku: string; product_name: string; expected_quantity: number; picked_quantity: number | null; base_unit: string
  batch_number: string | null; expiry_date: string | null; location_code: string | null; picking_sequence: number | null; short_reason: string | null; short_note: string | null
  exception_id: string | null; exception_status: string | null
}

export async function getQueue(status: string | null, mine: boolean): Promise<QueueRow[]> {
  const rows = unwrap(await supabase.rpc('fulfilment_queue', { p_status: status as unknown as string, p_mine: mine }), 'fulfilment.queue')
  return rows as unknown as QueueRow[]
}

export async function getFulfilmentOrder(id: string): Promise<(QueueRow) | null> {
  const rows = await getQueue(null, false)
  return rows.find((r) => r.id === id) ?? null
}

/** The live (not cancelled) order of an invoice, if it has been released. */
export async function getInvoiceFulfilment(invoiceId: string): Promise<Pick<FulfilmentOrder, 'id' | 'order_number' | 'status'> | null> {
  const res = await supabase.from('fulfilment_orders').select('id, order_number, status').eq('sales_invoice_id', invoiceId).neq('status', 'CANCELLED').maybeSingle()
  return unwrap(res, 'fulfilment.byInvoice')
}

export async function getPickLines(id: string): Promise<PickListLine[]> {
  const rows = unwrap(await supabase.rpc('fulfilment_pick_list', { p_id: id }), 'fulfilment.pickList')
  return rows.map((r) => ({ ...r, expected_quantity: Number(r.expected_quantity), picked_quantity: r.picked_quantity == null ? null : Number(r.picked_quantity) })) as unknown as PickListLine[]
}

export async function releaseToWarehouse(i: { invoiceId: string; priority: number; requiredBy?: string; notes?: string }): Promise<string> {
  return unwrap(
    await supabase.rpc('release_to_warehouse', { p_invoice_id: i.invoiceId, p_priority: i.priority, p_required_by: emptyToNull(i.requiredBy) as unknown as string, p_notes: emptyToNull(i.notes) as unknown as string }),
    'fulfilment.release',
  ) as string
}
export async function claimOrder(id: string): Promise<void> { unwrap(await supabase.rpc('claim_fulfilment_order', { p_id: id }), 'fulfilment.claim') }
export async function giveBackOrder(id: string): Promise<void> { unwrap(await supabase.rpc('release_fulfilment_claim', { p_id: id }), 'fulfilment.giveBack') }
export async function assignPicker(id: string, user: string | null): Promise<void> { unwrap(await supabase.rpc('assign_picker', { p_id: id, p_user: user as unknown as string }), 'fulfilment.assign') }
export async function cancelOrder(id: string, reason: string): Promise<void> { unwrap(await supabase.rpc('cancel_fulfilment_order', { p_id: id, p_reason: reason }), 'fulfilment.cancel') }
export async function resetLine(id: string, reason: string): Promise<void> { unwrap(await supabase.rpc('reset_pick_line', { p_line_id: id, p_reason: reason }), 'fulfilment.reset') }
export async function resolveShort(exceptionId: string, reason: string): Promise<string> {
  return unwrap(await supabase.rpc('resolve_short_pick', { p_exception_id: exceptionId, p_reason: reason }), 'fulfilment.resolve') as string
}
export async function confirmLine(i: { lineId: string; quantity: number; shortReason?: ShortReason; shortNote?: string; scannedBatch?: string; scannedBarcode?: string }): Promise<{ order_status: string; pending: number }> {
  return unwrap(
    await supabase.rpc('confirm_pick_line', {
      p_line_id: i.lineId, p_quantity: i.quantity, p_short_reason: (i.shortReason ?? null) as unknown as string, p_short_note: emptyToNull(i.shortNote) as unknown as string,
      p_scanned_batch: emptyToNull(i.scannedBatch) as unknown as string, p_scanned_barcode: emptyToNull(i.scannedBarcode) as unknown as string,
    }),
    'fulfilment.confirm',
  ) as unknown as { order_status: string; pending: number }
}
export async function pickerOptions(branchId: string): Promise<{ id: string; name: string }[]> {
  return unwrap(await supabase.rpc('picker_options', { p_branch_id: branchId }), 'fulfilment.pickers') as { id: string; name: string }[]
}
