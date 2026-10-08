import { sanitizeForOrFilter } from '@/lib/utils'
import { supabase } from '@/lib/supabase'
import type { PageParams, Paged, Tables } from '@/types/domain'
import { emptyToNull, rangeFor, unwrap, unwrapPaged } from './common'

export type Branch = Tables<'branches'>
export type ActiveFilter = 'all' | 'active' | 'inactive'

export interface BranchListParams extends PageParams {
  search: string
  status: ActiveFilter
  sortKey: 'name' | 'code' | 'created_at'
  sortDirection: 'asc' | 'desc'
}

export interface BranchInput {
  code: string
  name: string
  phone?: string | undefined
  email?: string | undefined
  address?: string | undefined
  city?: string | undefined
  region?: string | undefined
  is_head_office: boolean
  is_active: boolean
}

export async function listBranches(p: BranchListParams): Promise<Paged<Branch>> {
  let q = supabase.from('branches').select('*', { count: 'exact' })
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.or(`name.ilike.%${s}%,code.ilike.%${s}%,city.ilike.%${s}%`)
  if (p.status !== 'all') q = q.eq('is_active', p.status === 'active')
  const [from, to] = rangeFor(p)
  return unwrapPaged(
    await q.order(p.sortKey, { ascending: p.sortDirection === 'asc' }).order('id').range(from, to),
    'branches.list',
    p,
  )
}

/** All branches the caller can see (for pickers). Branch counts are small by nature. */
export async function listBranchOptions(): Promise<Pick<Branch, 'id' | 'code' | 'name' | 'is_active'>[]> {
  return unwrap(
    await supabase.from('branches').select('id, code, name, is_active').order('name').limit(500),
    'branches.options',
  )
}

const toRow = (i: BranchInput) => ({
  code: i.code.trim().toUpperCase(),
  name: i.name.trim(),
  phone: emptyToNull(i.phone),
  email: emptyToNull(i.email),
  address: emptyToNull(i.address),
  city: emptyToNull(i.city),
  region: emptyToNull(i.region),
  is_head_office: i.is_head_office,
  is_active: i.is_active,
})

// organization_id is intentionally NOT sent: the database fills it from the caller's session.
export async function createBranch(input: BranchInput): Promise<void> {
  unwrap(await supabase.from('branches').insert(toRow(input)).select('id').single(), 'branches.create')
}

export async function updateBranch(id: string, input: BranchInput): Promise<void> {
  unwrap(await supabase.from('branches').update(toRow(input)).eq('id', id).select('id').single(), 'branches.update')
}

export async function setBranchActive(id: string, isActive: boolean): Promise<void> {
  unwrap(await supabase.from('branches').update({ is_active: isActive }).eq('id', id).select('id').single(), 'branches.setActive')
}
