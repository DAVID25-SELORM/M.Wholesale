import { supabase } from '@/lib/supabase'
import type { PageParams, Paged } from '@/types/domain'
import { rangeFor, unwrap, unwrapPaged } from './common'

export const STOCK_STATUSES = ['AVAILABLE', 'QUARANTINE', 'DAMAGED', 'EXPIRED'] as const
export type StockStatus = (typeof STOCK_STATUSES)[number]
export const STOCK_STATUS_LABEL: Record<StockStatus, string> = {
  AVAILABLE: 'Available', QUARANTINE: 'Quarantine', DAMAGED: 'Damaged', EXPIRED: 'Expired',
}

export const DOCUMENT_TYPES = ['OPENING', 'ADJUSTMENT', 'TRANSFER', 'STATUS_CHANGE'] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]
/** Everything that can appear in the ledger. RECEIPT is posted by purchasing (goods received), never by hand. */
export type StockDocumentType = DocumentType | 'RECEIPT'
export const ALL_DOCUMENT_TYPES: readonly StockDocumentType[] = [...DOCUMENT_TYPES, 'RECEIPT']
export const DOCUMENT_TYPE_LABEL: Record<StockDocumentType, string> = {
  OPENING: 'Opening stock', ADJUSTMENT: 'Adjustment', TRANSFER: 'Transfer', STATUS_CHANGE: 'Status change', RECEIPT: 'Goods received',
}
/** Permission needed to post each kind of document (the database enforces the same mapping). */
export const DOCUMENT_PERMISSION: Record<DocumentType, string> = {
  OPENING: 'inventory.opening_stock', ADJUSTMENT: 'inventory.adjust', TRANSFER: 'inventory.transfer', STATUS_CHANGE: 'inventory.quarantine',
}

export const ADJUSTMENT_REASONS = [
  ['COUNT_VARIANCE', 'Stock count variance'], ['DAMAGE', 'Damaged'], ['EXPIRY_WRITE_OFF', 'Expiry write-off'],
  ['THEFT_LOSS', 'Theft / loss'], ['FOUND', 'Found stock'], ['RETURN_TO_STOCK', 'Returned to stock'], ['OTHER', 'Other'],
] as const
export const STATUS_CHANGE_REASONS = [
  ['QUALITY_HOLD', 'Quality hold'], ['QUALITY_RELEASE', 'Quality release'], ['RECALL', 'Recall'],
  ['DAMAGE', 'Damaged'], ['EXPIRY_WRITE_OFF', 'Expired'], ['REORGANISATION', 'Re-organisation'], ['OTHER', 'Other'],
] as const
export const REASON_LABEL: Record<string, string> = Object.fromEntries([
  ...ADJUSTMENT_REASONS, ...STATUS_CHANGE_REASONS, ['OPENING', 'Opening stock'], ['RECEIPT', 'Goods received'],
])

// ---- reads ---------------------------------------------------------------------------------------------------
export interface StockSummaryRow {
  product_id: string
  sku: string
  brand_name: string
  generic_name: string | null
  strength_text: string | null
  base_unit: string
  available: number
  quarantine: number
  damaged: number
  expired_status: number
  expired_unsold: number
  near_expiry: number
  earliest_expiry: string | null
}

export const NEAR_EXPIRY_DAYS = 90

export interface StockSummaryParams extends PageParams {
  warehouseId: string
  search: string
}

export async function listStockSummary(p: StockSummaryParams): Promise<Paged<StockSummaryRow>> {
  const rows = unwrap(
    await supabase.rpc('stock_summary', {
      p_warehouse_id: p.warehouseId || undefined, p_query: p.search.trim() || undefined, p_near_days: NEAR_EXPIRY_DAYS,
      p_limit: p.pageSize, p_offset: p.page * p.pageSize,
    }),
    'stock.summary',
  )
  const total = rows[0] ? Number(rows[0].total_count) : 0
  return {
    total,
    hasNext: (p.page + 1) * p.pageSize < total,
    rows: rows.map((r) => ({
      product_id: r.product_id, sku: r.sku, brand_name: r.brand_name, generic_name: r.generic_name, strength_text: r.strength_text,
      base_unit: r.base_unit, available: Number(r.available), quarantine: Number(r.quarantine), damaged: Number(r.damaged),
      expired_status: Number(r.expired_status), expired_unsold: Number(r.expired_unsold), near_expiry: Number(r.near_expiry),
      earliest_expiry: r.earliest_expiry,
    })),
  }
}

export interface BalanceRow {
  id: string
  warehouse_id: string
  location_id: string | null
  product_id: string
  batch_id: string | null
  stock_status: StockStatus
  quantity: number
  warehouse: { code: string; name: string } | null
  location: { code: string } | null
  batch: { batch_number: string; expiry_date: string } | null
}

const BALANCE_SELECT = '*, warehouse:warehouses(code, name), location:warehouse_locations(code), batch:batches(batch_number, expiry_date)'

/** Positive balances of one product, optionally within one warehouse, earliest expiry first. */
export async function listProductBalances(productId: string, warehouseId?: string): Promise<BalanceRow[]> {
  let q = supabase.from('stock_balances').select(BALANCE_SELECT).eq('product_id', productId).gt('quantity', 0)
  if (warehouseId) q = q.eq('warehouse_id', warehouseId)
  const rows = unwrap(await q.limit(500), 'stock.balances') as unknown as BalanceRow[]
  return rows
    .map((r) => ({ ...r, quantity: Number(r.quantity) }))
    .sort((a, b) => (a.batch?.expiry_date ?? '9999').localeCompare(b.batch?.expiry_date ?? '9999') || (a.batch?.batch_number ?? '').localeCompare(b.batch?.batch_number ?? ''))
}

export interface ExpiringRow {
  warehouse_id: string
  warehouse_name: string
  location_id: string | null
  product_id: string
  sku: string
  brand_name: string
  batch_id: string
  batch_number: string
  expiry_date: string
  days_to_expiry: number
  stock_status: StockStatus
  quantity: number
}

export async function listExpiringStock(withinDays: number, warehouseId: string): Promise<ExpiringRow[]> {
  const rows = unwrap(
    await supabase.rpc('expiring_stock', { p_within_days: withinDays, p_warehouse_id: warehouseId || undefined }),
    'stock.expiring',
  )
  return rows.map((r) => ({ ...r, stock_status: r.stock_status as StockStatus, quantity: Number(r.quantity) }))
}

export interface MovementRow {
  id: string
  seq: number
  movement_type: string
  stock_status: StockStatus
  quantity: number
  posted_at: string
  warehouse: { code: string; name: string } | null
  location: { code: string } | null
  batch: { batch_number: string; expiry_date: string } | null
  product: { sku: string; brand_name: string } | null
  document: { document_number: string; document_type: StockDocumentType; reason_code: string | null } | null
}

const MOVEMENT_SELECT =
  '*, warehouse:warehouses(code, name), location:warehouse_locations(code), batch:batches(batch_number, expiry_date), product:products(sku, brand_name), document:stock_documents(document_number, document_type, reason_code)'

export async function listProductMovements(productId: string, p: PageParams): Promise<Paged<MovementRow>> {
  const [from, to] = rangeFor(p)
  const res = unwrapPaged(
    await supabase.from('stock_movements').select(MOVEMENT_SELECT, { count: 'exact' }).eq('product_id', productId).order('seq', { ascending: false }).range(from, to),
    'stock.movements',
    p,
  )
  return { ...res, rows: (res.rows as unknown as MovementRow[]).map((r) => ({ ...r, quantity: Number(r.quantity) })) }
}

export async function listDocumentMovements(documentId: string): Promise<MovementRow[]> {
  const rows = unwrap(
    await supabase.from('stock_movements').select(MOVEMENT_SELECT).eq('document_id', documentId).order('line_no').order('quantity'),
    'stock.documentMovements',
  ) as unknown as MovementRow[]
  return rows.map((r) => ({ ...r, quantity: Number(r.quantity) }))
}

export interface StockDocumentRow {
  id: string
  document_number: string
  document_type: StockDocumentType
  reason_code: string | null
  notes: string | null
  line_count: number
  posted_at: string
  warehouse: { code: string; name: string } | null
  to_warehouse: { code: string; name: string } | null
}

export interface DocumentListParams extends PageParams {
  type: StockDocumentType | ''
  warehouseId: string
}

export async function listStockDocuments(p: DocumentListParams): Promise<Paged<StockDocumentRow>> {
  let q = supabase
    .from('stock_documents')
    .select('*, warehouse:warehouses!stock_documents_warehouse_fk(code, name), to_warehouse:warehouses!stock_documents_to_warehouse_fk(code, name)', { count: 'exact' })
  if (p.type) q = q.eq('document_type', p.type)
  if (p.warehouseId) q = q.or(`warehouse_id.eq.${p.warehouseId},to_warehouse_id.eq.${p.warehouseId}`)
  const [from, to] = rangeFor(p)
  const res = unwrapPaged(await q.order('posted_at', { ascending: false }).order('id').range(from, to), 'stock.documents', p)
  return { ...res, rows: res.rows as unknown as StockDocumentRow[] }
}

export async function listLocationOptions(warehouseId: string): Promise<{ id: string; code: string }[]> {
  return unwrap(
    await supabase.from('warehouse_locations').select('id, code').eq('warehouse_id', warehouseId).eq('is_active', true).order('picking_sequence').order('code').limit(500),
    'stock.locationOptions',
  )
}

// ---- posting -------------------------------------------------------------------------------------------------
export interface PostLine {
  product_id: string
  quantity: number
  product_unit_id?: string
  batch_id?: string
  batch_number?: string
  expiry_date?: string
  manufacture_date?: string
  location_id?: string
  status?: StockStatus
  direction?: 'IN' | 'OUT'
  to_status?: StockStatus
  to_location_id?: string
}

export interface PostDocumentInput {
  type: DocumentType
  warehouseId: string
  toWarehouseId?: string
  reasonCode?: string
  notes?: string
  lines: PostLine[]
}

export async function postStockDocument(i: PostDocumentInput): Promise<{ document_id: string; document_number: string }> {
  const res = unwrap(
    await supabase.rpc('post_stock_document', {
      p_document_type: i.type,
      p_warehouse_id: i.warehouseId,
      p_lines: i.lines as unknown as never,
      p_to_warehouse_id: i.toWarehouseId || undefined,
      p_reason_code: i.reasonCode || undefined,
      p_notes: i.notes?.trim() || undefined,
    }),
    'stock.post',
  )
  return res as unknown as { document_id: string; document_number: string }
}

// ---- display helpers ------------------------------------------------------------------------------------------
export type ExpiryTone = 'red' | 'amber' | 'slate'
export function expiryTone(daysToExpiry: number): ExpiryTone {
  if (daysToExpiry < 0) return 'red'
  if (daysToExpiry <= 30) return 'red'
  if (daysToExpiry <= NEAR_EXPIRY_DAYS) return 'amber'
  return 'slate'
}
export function expiryLabel(daysToExpiry: number): string {
  if (daysToExpiry < 0) return `Expired ${-daysToExpiry} d ago`
  if (daysToExpiry === 0) return 'Expires today'
  return `${daysToExpiry} d left`
}
export function daysUntil(isoDate: string, today = new Date()): number {
  const t = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number)
  return Math.round((Date.UTC(y!, m! - 1, d!) - t) / 86_400_000)
}
export const fmtQty = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 3 })
