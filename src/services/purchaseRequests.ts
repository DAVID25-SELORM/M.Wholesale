import { supabase } from '@/lib/supabase'
import { unwrap } from './common'
import type { Tables } from '@/types/domain'
export async function listPurchaseRequests(branch: string, page: number): Promise<Tables<'purchase_requests'>[]> {
  let query = supabase.from('purchase_requests').select('*').order('created_at', { ascending: false }).order('id').range(page * 25, page * 25 + 24)
  if (branch !== 'ALL') query = query.eq('branch_id', branch)
  const rows = unwrap(await query, 'requests.list')
  const ids = [...new Set(rows.flatMap(r => Array.isArray(r.lines) ? r.lines.flatMap(l => l && typeof l === 'object' && !Array.isArray(l) && typeof l.product_id === 'string' ? [l.product_id] : []) : []))]
  if (!ids.length) return rows
  const products = unwrap(await supabase.from('products').select('id,sku,brand_name').in('id', ids), 'requests.lineProducts')
  const labels = new Map(products.map(p => [p.id, `${p.sku} / ${p.brand_name}`]))
  return rows.map(r => ({ ...r, lines: Array.isArray(r.lines) ? r.lines.map(l => l && typeof l === 'object' && !Array.isArray(l) ? { ...l, label: labels.get(String(l.product_id)) ?? String(l.product_id) } : l) : r.lines }))
}
export async function requestProducts(search: string) {
  let query = supabase.from('products').select('id,sku,brand_name').eq('is_active', true).order('brand_name').limit(50)
  if (search.trim()) query = query.ilike('brand_name', `%${search.trim().replace(/[%_]/g, '')}%`)
  return unwrap(await query, 'requests.products')
}
export async function createPurchaseRequest(branch: string, date: string, notes: string, lines: { product_id: string; quantity: number }[]) {
  return unwrap(await supabase.rpc('create_purchase_request', { p_branch_id: branch, p_warehouse_id: null, p_needed_by: date || null, p_notes: notes, p_lines: lines }), 'requests.create')
}
export async function submitPurchaseRequest(id: string) { unwrap(await supabase.rpc('submit_purchase_request', { p_id: id }), 'requests.submit') }
export async function decidePurchaseRequest(id: string, approve: boolean, note: string) { unwrap(await supabase.rpc('decide_purchase_request', { p_id: id, p_approve: approve, p_note: note }), 'requests.decide') }
export async function cancelPurchaseRequest(id: string, note: string) { unwrap(await supabase.rpc('cancel_purchase_request', { p_id: id, p_note: note }), 'requests.cancel') }
