import { supabase } from '@/lib/supabase'
import { unwrap } from './common'
export async function recallCustomerExposure(recallId: string) { return unwrap(await supabase.rpc('recall_customer_exposure', { p_recall_id: recallId }), 'recalls.exposure') }
export interface RecallRow { id: string; recall_number: string; source: string; recall_class: string; title: string; instructions: string; status: string; opened_at: string }
export async function listRecalls(): Promise<RecallRow[]> { const result = await supabase.from('recalls').select('id,recall_number,source,recall_class,title,instructions,status,opened_at').order('opened_at', { ascending: false }); return unwrap(result, 'recalls.list') }
export async function listRecallScope(recallId: string) { return unwrap(await supabase.from('recall_batch_scope').select('id,batch_id,product_id,quarantined_at,released_at,release_reason').eq('recall_id', recallId).order('added_at'), 'recalls.scope') }
export async function closeRecall(id: string): Promise<void> { unwrap(await supabase.rpc('close_recall', { p_recall_id: id }), 'recalls.close') }
export async function createRecall(source: string, recallClass: string, title: string, instructions: string): Promise<string> { return unwrap(await supabase.rpc('create_recall', { p_source: source, p_class: recallClass, p_title: title, p_instructions: instructions }), 'recalls.create') as string }
export async function recallBatchOptions(): Promise<Array<{ id: string; batch_number: string; product_name: string; sku: string; expiry_date: string }>> { return unwrap(await supabase.rpc('recall_batch_options'), 'recalls.batchOptions') as Array<{ id: string; batch_number: string; product_name: string; sku: string; expiry_date: string }> }
export async function addRecallBatch(recallId: string, batchId: string): Promise<string> { return unwrap(await supabase.rpc('add_recall_batch', { p_recall_id: recallId, p_batch_id: batchId }), 'recalls.addBatch') as string }
export async function quarantineRecallBatch(scopeId: string, reason: string): Promise<void> { unwrap(await supabase.rpc('quarantine_recall_batch', { p_scope_id: scopeId, p_reason: reason }), 'recalls.quarantine') }
export async function cancelRecall(id: string, reason: string): Promise<void> { unwrap(await supabase.rpc('cancel_recall', { p_recall_id: id, p_reason: reason }), 'recalls.cancel') }
export async function releaseRecallBatch(scopeId: string, reason: string): Promise<void> { unwrap(await supabase.rpc('release_recall_batch', { p_scope_id: scopeId, p_reason: reason }), 'recalls.release') }
export async function recordRecallRecovery(scopeId: string, invoiceId: string, quantity: number, status: string, notes: string): Promise<string> { return unwrap(await supabase.rpc('record_recall_recovery', { p_scope_id: scopeId, p_invoice_id: invoiceId, p_quantity: quantity, p_status: status, p_notes: notes }), 'recalls.recovery') as string }
export async function listRecallRecoveries(recallId: string) {
  const scopes = unwrap(await supabase.from('recall_batch_scope').select('id').eq('recall_id', recallId), 'recalls.recoveryScopes')
  if (!scopes.length) return []
  return unwrap(await supabase.from('recall_recoveries').select('id,recall_batch_scope_id,sales_invoice_id,quantity,status,notes,updated_at').in('recall_batch_scope_id', scopes.map(s => s.id)).order('updated_at', { ascending: false }), 'recalls.recoveries')
}