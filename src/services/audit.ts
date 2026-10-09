import { supabase } from '@/lib/supabase'
import { sanitizeForOrFilter } from '@/lib/utils'
import type { PageParams, Paged, Tables } from '@/types/domain'
import { rangeFor, unwrap } from './common'

export type AuditEntry = Tables<'audit_logs'> & { actor_name: string | null }

export interface AuditListParams extends PageParams {
  branchId: string | null
  entityType: string
  action: string
  from: string // yyyy-mm-dd or ''
  to: string // yyyy-mm-dd or ''
}

/**
 * Newest first. Never counts rows (the table grows without bound) - it fetches one extra row to know
 * whether a next page exists. Actor names are resolved with ONE extra query per page, not per row.
 */
export async function listAudit(p: AuditListParams): Promise<Paged<AuditEntry>> {
  let q = supabase.from('audit_logs').select('*')
  if (p.branchId) q = q.eq('branch_id', p.branchId)
  if (p.entityType) q = q.eq('entity_type', p.entityType)
  const a = sanitizeForOrFilter(p.action)
  if (a) q = q.ilike('action', `%${a}%`)
  if (p.from) q = q.gte('created_at', `${p.from}T00:00:00`)
  if (p.to) q = q.lt('created_at', nextDay(p.to))
  const [from, to] = rangeFor(p)
  const rows = unwrap(
    await q.order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to + 1),
    'audit.list',
  )
  const hasNext = rows.length > p.pageSize
  const page = rows.slice(0, p.pageSize)

  const actorIds = [...new Set(page.map((r) => r.actor_user_id).filter((x): x is string => Boolean(x)))]
  const names = new Map<string, string>()
  if (actorIds.length > 0) {
    // Visible only to users who may view profiles; otherwise the id is shown shortened.
    const { data } = await supabase.from('profiles').select('id, first_name, last_name').in('id', actorIds)
    for (const r of data ?? []) names.set(r.id, `${r.first_name} ${r.last_name}`)
  }
  return {
    rows: page.map((r) => ({ ...r, actor_name: r.actor_user_id ? (names.get(r.actor_user_id) ?? null) : null })),
    hasNext,
  }
}

function nextDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return `${d.toISOString().slice(0, 10)}T00:00:00`
}

export const AUDIT_ENTITY_TYPES = [
  'organization', 'branch', 'warehouse', 'warehouse_location', 'user', 'user_role', 'system_setting',
  'product', 'product_identity', 'product_unit', 'product_barcode', 'product_alias', 'manufacturer', 'product_category',
  'supplier', 'supplier_product',
] as const
