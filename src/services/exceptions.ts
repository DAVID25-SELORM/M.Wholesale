import { supabase } from '@/lib/supabase'
import { unwrap } from './common'

export interface FulfilmentExceptionRow {
  id: string; branch_id: string; fulfilment_order_id: string; pick_line_id: string; short_quantity: number; reason: string; status: string; decision: string | null; raised_at: string
}

export async function getOpenFulfilmentExceptions(): Promise<FulfilmentExceptionRow[]> {
  const { data, error } = await supabase.from('fulfilment_exceptions').select('id,branch_id,fulfilment_order_id,pick_line_id,short_quantity,reason,status,decision,raised_at').eq('status', 'OPEN').order('raised_at')
  return unwrap({ data, error }, 'fulfilment.exceptions') as unknown as FulfilmentExceptionRow[]
}

export async function acceptShort(exceptionId: string, reason: string): Promise<string> {
  return unwrap(await supabase.rpc('resolve_short_pick', { p_exception_id: exceptionId, p_reason: reason }), 'fulfilment.acceptShort') as string
}

export async function shipShort(exceptionId: string, reason: string): Promise<string> {
  return unwrap(await supabase.rpc('ship_short_fulfilment_order', { p_exception_id: exceptionId, p_reason: reason }), 'fulfilment.shipShort') as string
}

export async function holdOrder(orderId: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('hold_fulfilment_order', { p_id: orderId, p_reason: reason }), 'fulfilment.hold')
}

export async function releaseHold(orderId: string): Promise<void> {
  unwrap(await supabase.rpc('release_fulfilment_hold', { p_id: orderId }), 'fulfilment.releaseHold')
}

export async function substitutionBatchOptions(exceptionId: string): Promise<Array<{ id: string; batch_number: string; expiry_date: string; available_quantity: number; is_controlled: boolean; stock_balance_id: string; location_code: string }>> {
  return unwrap(await supabase.rpc('substitution_batch_options', { p_exception_id: exceptionId }), 'fulfilment.substitutionBatchOptions') as Array<{ id: string; batch_number: string; expiry_date: string; available_quantity: number; is_controlled: boolean; stock_balance_id: string; location_code: string }>
}

export async function substituteBatch(exceptionId: string, batchId: string, reason: string, stockBalanceId: string): Promise<void> {
  unwrap(await supabase.rpc('submit_batch_substitution', { p_exception_id: exceptionId, p_substitute_batch_id: batchId, p_reason: reason, p_stock_balance_id: stockBalanceId }), 'fulfilment.submitSubstitution')
}
