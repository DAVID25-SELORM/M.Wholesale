import { supabase } from '@/lib/supabase'
import type { Json } from '@/types/database'
import { unwrap } from './common'
import type { PostLine } from './inventory'

export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'

export interface ControlledAdjustment {
  id: string; request_number: string; branch_id: string; warehouse_id: string; reason_code: string; notes: string; lines: PostLine[]
  status: RequestStatus; requested_by: string; requested_at: string; decided_by: string | null; decided_at: string | null; decision_note: string | null
  stock_document_id: string | null
  warehouse: { name: string } | null
}

const SELECT = 'id, request_number, branch_id, warehouse_id, reason_code, notes, lines, status, requested_by, requested_at, decided_by, decided_at, decision_note, stock_document_id, warehouse:warehouses(name)'

export async function listControlledAdjustments(status: RequestStatus | ''): Promise<ControlledAdjustment[]> {
  let q = supabase.from('controlled_adjustments').select(SELECT)
  if (status) q = q.eq('status', status)
  const rows = unwrap(await q.order('requested_at', { ascending: false }).limit(200), 'controlled.list')
  return rows as unknown as ControlledAdjustment[]
}

export async function requestControlledAdjustment(i: { warehouseId: string; lines: PostLine[]; reasonCode: string; notes: string }): Promise<{ id: string; request_number: string }> {
  const r = unwrap(await supabase.rpc('request_controlled_adjustment', { p_warehouse_id: i.warehouseId, p_lines: i.lines as unknown as Json, p_reason_code: i.reasonCode, p_notes: i.notes.trim() }), 'controlled.request')
  return r as unknown as { id: string; request_number: string }
}

export async function approveControlledAdjustment(id: string): Promise<{ document_number: string }> {
  return unwrap(await supabase.rpc('approve_controlled_adjustment', { p_id: id }), 'controlled.approve') as unknown as { document_number: string }
}

export async function rejectControlledAdjustment(id: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('reject_controlled_adjustment', { p_id: id, p_reason: reason.trim() }), 'controlled.reject')
}

export async function cancelControlledAdjustment(id: string): Promise<void> {
  unwrap(await supabase.rpc('cancel_controlled_adjustment', { p_id: id }), 'controlled.cancel')
}

/** Product names for the lines of a request (the lines themselves only hold ids). */
export async function productNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = unwrap(await supabase.from('products').select('id, sku, brand_name').in('id', ids), 'controlled.products')
  return new Map(rows.map((r) => [r.id, `${r.brand_name} (${r.sku})`]))
}
