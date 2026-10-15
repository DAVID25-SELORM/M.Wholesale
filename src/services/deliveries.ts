import { supabase } from '@/lib/supabase'
import { sanitizeForOrFilter } from '@/lib/utils'
import type { PageParams, Paged, Tables } from '@/types/domain'
import { emptyToNull, rangeFor, unwrap, unwrapPaged } from './common'

export const DELIVERY_STATUSES = ['PREPARED', 'DISPATCHED', 'DELIVERED', 'FAILED', 'CANCELLED'] as const
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]
export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = {
  PREPARED: 'To dispatch', DISPATCHED: 'On the road', DELIVERED: 'Delivered', FAILED: 'Failed', CANCELLED: 'Cancelled',
}

export type DeliveryNote = Tables<'delivery_notes'> & {
  customer: { code: string; name: string } | null
  invoice: { invoice_number: string | null } | null
  warehouse: { code: string; name: string } | null
}

const SELECT =
  '*, customer:customers!delivery_notes_customer_fk(code, name), invoice:sales_invoices!delivery_notes_invoice_fk(invoice_number), warehouse:warehouses!delivery_notes_warehouse_fk(code, name)'

export interface DeliveryListParams extends PageParams {
  search: string
  status: DeliveryStatus | ''
  customerId: string
}

export async function listDeliveryNotes(p: DeliveryListParams): Promise<Paged<DeliveryNote>> {
  let q = supabase.from('delivery_notes').select(SELECT, { count: 'exact' })
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.or(`note_number.ilike.%${s}%,driver_name.ilike.%${s}%,vehicle_number.ilike.%${s}%`)
  if (p.status) q = q.eq('status', p.status)
  if (p.customerId) q = q.eq('customer_id', p.customerId)
  const [from, to] = rangeFor(p)
  const res = unwrapPaged(await q.order('prepared_at', { ascending: false }).order('id').range(from, to), 'deliveries.list', p)
  return { ...res, rows: res.rows as unknown as DeliveryNote[] }
}

export async function getDeliveryNote(id: string): Promise<DeliveryNote | null> {
  const res = await supabase.from('delivery_notes').select(SELECT).eq('id', id).maybeSingle()
  return unwrap(res, 'deliveries.get') as unknown as DeliveryNote | null
}

/** The live (not failed or cancelled) delivery note of an invoice, if any. */
export async function getInvoiceDelivery(invoiceId: string): Promise<DeliveryNote | null> {
  const res = await supabase.from('delivery_notes').select(SELECT).eq('sales_invoice_id', invoiceId).in('status', ['PREPARED', 'DISPATCHED', 'DELIVERED']).maybeSingle()
  return unwrap(res, 'deliveries.byInvoice') as unknown as DeliveryNote | null
}

export interface PickLine {
  line_no: number
  sku: string
  product_name: string
  line_quantity: number
  line_unit: string
  base_quantity: number
  base_unit: string
  batch_number: string | null
  expiry_date: string | null
  location_code: string | null
  picking_sequence: number | null
}

export async function getPickList(id: string): Promise<PickLine[]> {
  const rows = unwrap(await supabase.rpc('delivery_pick_list', { p_id: id }), 'deliveries.pickList')
  return rows.map((r) => ({ ...r, line_quantity: Number(r.line_quantity), base_quantity: Number(r.base_quantity) }))
}

export async function prepareDeliveryNote(i: { invoiceId: string; address?: string; contactName?: string; contactPhone?: string; packages: number; notes?: string }): Promise<string> {
  return unwrap(
    await supabase.rpc('prepare_delivery_note', {
      p_invoice_id: i.invoiceId, p_address: emptyToNull(i.address) as unknown as string, p_contact_name: emptyToNull(i.contactName) as unknown as string,
      p_contact_phone: emptyToNull(i.contactPhone) as unknown as string, p_packages: i.packages, p_notes: emptyToNull(i.notes) as unknown as string,
    }),
    'deliveries.prepare',
  ) as string
}
export async function dispatchDeliveryNote(id: string, driver: string, vehicle?: string): Promise<void> {
  unwrap(await supabase.rpc('dispatch_delivery_note', { p_id: id, p_driver_name: driver, p_vehicle_number: emptyToNull(vehicle) as unknown as string }), 'deliveries.dispatch')
}
export async function confirmDelivery(id: string, receivedBy: string, notes?: string): Promise<void> {
  unwrap(await supabase.rpc('confirm_delivery', { p_id: id, p_received_by_name: receivedBy, p_notes: emptyToNull(notes) ?? undefined }), 'deliveries.confirm')
}
export async function failDelivery(id: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('fail_delivery', { p_id: id, p_reason: reason }), 'deliveries.fail')
}
export async function cancelDeliveryNote(id: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('cancel_delivery_note', { p_id: id, p_reason: reason }), 'deliveries.cancel')
}
