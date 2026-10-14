import { supabase } from '@/lib/supabase'
import type { PageParams, Paged, Tables } from '@/types/domain'
import { emptyToNull, rangeFor, unwrap, unwrapPaged } from './common'
import type { StockStatus } from './inventory'

export const COUNT_STATUSES = ['OPEN', 'SUBMITTED', 'APPROVED', 'CANCELLED'] as const
export type CountStatus = (typeof COUNT_STATUSES)[number]
export const COUNT_STATUS_LABEL: Record<CountStatus, string> = {
  OPEN: 'Counting', SUBMITTED: 'Awaiting approval', APPROVED: 'Approved', CANCELLED: 'Cancelled',
}
export const COUNT_STATUS_TONE: Record<CountStatus, 'blue' | 'amber' | 'green' | 'red'> = {
  OPEN: 'blue', SUBMITTED: 'amber', APPROVED: 'green', CANCELLED: 'red',
}

export type StockCount = Tables<'stock_counts'> & {
  warehouse: { code: string; name: string } | null
  location: { code: string } | null
}

const COUNT_SELECT = '*, warehouse:warehouses!stock_counts_warehouse_fk(code, name), location:warehouse_locations(code)'

export interface CountListParams extends PageParams {
  status: CountStatus | ''
}

export async function listStockCounts(p: CountListParams): Promise<Paged<StockCount>> {
  let q = supabase.from('stock_counts').select(COUNT_SELECT, { count: 'exact' })
  if (p.status) q = q.eq('status', p.status)
  const [from, to] = rangeFor(p)
  const res = unwrapPaged(await q.order('created_at', { ascending: false }).order('id').range(from, to), 'stockCounts.list', p)
  return { ...res, rows: res.rows as unknown as StockCount[] }
}

export async function getStockCount(id: string): Promise<StockCount | null> {
  const res = await supabase.from('stock_counts').select(COUNT_SELECT).eq('id', id).maybeSingle()
  return unwrap(res, 'stockCounts.get') as unknown as StockCount | null
}

export type StockCountLine = Tables<'stock_count_lines'> & {
  product: { sku: string; brand_name: string } | null
  batch: { batch_number: string; expiry_date: string } | null
  location: { code: string } | null
  stock_status: StockStatus
}

export async function listCountLines(countId: string): Promise<StockCountLine[]> {
  const rows = unwrap(
    await supabase
      .from('stock_count_lines')
      .select('*, product:products!stock_count_lines_product_fk(sku, brand_name), batch:batches!stock_count_lines_batch_fk(batch_number, expiry_date), location:warehouse_locations(code)')
      .eq('stock_count_id', countId)
      .order('line_no')
      .limit(5000),
    'stockCounts.lines',
  )
  return rows as unknown as StockCountLine[]
}

export interface StartCountInput { warehouseId: string; locationId?: string; productIds?: string[]; notes?: string }

export async function startStockCount(i: StartCountInput): Promise<string> {
  return unwrap(
    await supabase.rpc('start_stock_count', {
      p_warehouse_id: i.warehouseId, p_location_id: i.locationId || undefined,
      p_product_ids: i.productIds && i.productIds.length > 0 ? i.productIds : undefined, p_notes: emptyToNull(i.notes) ?? undefined,
    }),
    'stockCounts.start',
  ) as string
}

export interface CountEntry { line_id: string; counted_quantity: number | null }

export async function saveCountEntries(id: string, entries: CountEntry[]): Promise<number> {
  return unwrap(await supabase.rpc('save_count_entries', { p_id: id, p_entries: entries as unknown as never }), 'stockCounts.save') as number
}
export async function submitStockCount(id: string): Promise<void> {
  unwrap(await supabase.rpc('submit_stock_count', { p_id: id }), 'stockCounts.submit')
}
export async function returnStockCount(id: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('return_stock_count', { p_id: id, p_reason: reason }), 'stockCounts.return')
}
export async function cancelStockCount(id: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('cancel_stock_count', { p_id: id, p_reason: reason }), 'stockCounts.cancel')
}
export async function approveStockCount(id: string): Promise<{ variances: number; stock_document_number: string | null }> {
  return unwrap(await supabase.rpc('approve_stock_count', { p_id: id }), 'stockCounts.approve') as unknown as { variances: number; stock_document_number: string | null }
}

/** variance of one line: counted - system (null while uncounted) */
export const lineVariance = (l: Pick<StockCountLine, 'system_quantity' | 'counted_quantity'>): number | null =>
  l.counted_quantity === null ? null : Math.round((Number(l.counted_quantity) - Number(l.system_quantity)) * 1000) / 1000
