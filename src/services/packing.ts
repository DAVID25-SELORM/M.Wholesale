import { supabase } from '@/lib/supabase'
import { unwrap } from './common'
import { getQueue } from './fulfilment'

export async function getDispatchQueue() {
  const ready = unwrap(await supabase.rpc('packed_dispatch_queue'), 'packing.dispatchQueue')
  const ids = new Set(ready.map(r => r.id))
  return (await getQueue(null, false)).filter(r => ids.has(r.id))
}

export interface Package {
  id: string; package_number: string; kind: string; cold_chain: boolean; fragile: boolean; voided_at: string | null; void_reason: string | null
}
export interface PackingDetail {
  packages: Package[]
  contents: { id: string; package_id: string; pick_line_id: string; quantity: number; packed_by: string }[]
  lines: { id: string; product_name: string; controlled: boolean; verified: boolean }[]
}
export async function getPackingDetail(id: string): Promise<PackingDetail> {
  return unwrap(await supabase.rpc('packing_detail', { p_id: id }), 'packing.detail') as unknown as PackingDetail
}
export async function startPacking(id: string) { unwrap(await supabase.rpc('start_packing', { p_id: id }), 'packing.start') }
export async function createPackage(id: string, kind: string, cold: boolean, fragile: boolean) {
  return unwrap(await supabase.rpc('create_package', { p_id: id, p_kind: kind, p_cold_chain: cold, p_fragile: fragile }), 'packing.package')
}
export async function packLine(packageId: string, lineId: string, quantity: number) {
  unwrap(await supabase.rpc('pack_line', { p_package_id: packageId, p_line_id: lineId, p_quantity: quantity }), 'packing.line')
}
export async function voidPackage(id: string, reason: string) { unwrap(await supabase.rpc('void_package', { p_id: id, p_reason: reason }), 'packing.void') }
export async function verifyPackedLine(id: string) { unwrap(await supabase.rpc('verify_packed_line', { p_id: id }), 'packing.verify') }
export async function finishPacking(id: string) { unwrap(await supabase.rpc('finish_packing', { p_id: id }), 'packing.finish') }
export async function preparePackedDelivery(id: string, address: string, contact: string, phone: string, notes: string) {
  return unwrap(await supabase.rpc('prepare_packed_delivery', { p_id: id, p_address: address, p_contact_name: contact, p_contact_phone: phone, p_notes: notes }), 'packing.delivery')
}
