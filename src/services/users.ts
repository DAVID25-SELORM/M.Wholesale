import { FunctionsHttpError } from '@supabase/supabase-js'
import { AppError, logError, type AppErrorKind } from '@/lib/errors'
import { supabase } from '@/lib/supabase'
import { sanitizeForOrFilter } from '@/lib/utils'
import type { PageParams, Paged, Tables } from '@/types/domain'
import type { ActiveFilter } from './branches'
import { emptyToNull, rangeFor, unwrap, unwrapPaged } from './common'

export interface UserRow extends Tables<'profiles'> {
  default_branch: { name: string } | null
  user_roles: { id: string; branch_id: string | null; roles: { code: string; name: string } | null }[]
}

export interface UserListParams extends PageParams {
  search: string
  status: ActiveFilter
  sortKey: 'last_name' | 'created_at'
  sortDirection: 'asc' | 'desc'
}

const USER_SELECT =
  '*, default_branch:branches!profiles_default_branch_fk(name), user_roles(id, branch_id, roles(code, name))'

export async function listUsers(p: UserListParams): Promise<Paged<UserRow>> {
  let q = supabase.from('profiles').select(USER_SELECT, { count: 'exact' })
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,email.ilike.%${s}%,employee_code.ilike.%${s}%`)
  if (p.status !== 'all') q = q.eq('is_active', p.status === 'active')
  const [from, to] = rangeFor(p)
  return unwrapPaged(
    await q.order(p.sortKey, { ascending: p.sortDirection === 'asc' }).order('id').range(from, to),
    'users.list',
    p,
  ) as unknown as Paged<UserRow>
}

export interface ProfileInput {
  first_name: string
  last_name: string
  phone?: string | undefined
  employee_code?: string | undefined
  job_title?: string | undefined
  default_branch_id: string | null
}

export async function updateProfile(id: string, i: ProfileInput, canEditEmployeeFields: boolean): Promise<void> {
  unwrap(
    await supabase.from('profiles').update({
      first_name: i.first_name.trim(),
      last_name: i.last_name.trim(),
      phone: emptyToNull(i.phone),
      default_branch_id: i.default_branch_id,
      ...(canEditEmployeeFields ? { employee_code: emptyToNull(i.employee_code), job_title: emptyToNull(i.job_title) } : {}),
    }).eq('id', id).select('id').single(),
    'users.update',
  )
}

// ---- invitations (Edge Function `invite-user`: the database decides who may invite whom) -----

export interface InviteInput {
  email: string
  first_name: string
  last_name: string
  role_id: string
  branch_id: string | null
  job_title?: string | undefined
}

const kindForStatus = (s: number): AppErrorKind =>
  s === 403 ? 'permission' : s === 404 ? 'not_found' : s === 409 ? 'duplicate' : s === 400 ? 'validation' : s === 401 ? 'auth' : 'unknown'

async function callInviteFunction(body: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.functions.invoke('invite-user', { body })
  if (!error) return
  logError('invite-user', error)
  if (error instanceof FunctionsHttpError) {
    const res = error.context as Response
    const detail = (await res.json().catch(() => null)) as { error?: string } | null
    throw new AppError(kindForStatus(res.status), detail?.error ?? 'The invitation could not be sent.', { code: String(res.status) })
  }
  throw new AppError('network', 'Cannot reach the server. Check your connection and try again.', { cause: error })
}

export function inviteUser(i: InviteInput): Promise<void> {
  return callInviteFunction({
    action: 'invite',
    email: i.email.trim(),
    first_name: i.first_name.trim(),
    last_name: i.last_name.trim(),
    role_id: i.role_id,
    branch_id: i.branch_id,
    job_title: i.job_title?.trim() || undefined,
  })
}

export function resendInvitation(userId: string): Promise<void> {
  return callInviteFunction({ action: 'resend', user_id: userId })
}

// ---- guarded RPCs (authorization + anti-escalation + audit happen in the database) ----------

export async function setUserActive(userId: string, isActive: boolean, reason?: string): Promise<void> {
  unwrap(
    await supabase.rpc('set_user_active', { p_user_id: userId, p_is_active: isActive, ...(reason ? { p_reason: reason } : {}) }),
    'users.setActive',
  )
}

export async function assignUserRole(userId: string, roleId: string, branchId: string | null, reason?: string): Promise<void> {
  unwrap(
    await supabase.rpc('assign_user_role', {
      p_user_id: userId, p_role_id: roleId,
      ...(branchId ? { p_branch_id: branchId } : {}),
      ...(reason ? { p_reason: reason } : {}),
    }),
    'roles.assign',
  )
}

export async function revokeUserRole(userRoleId: string, reason?: string): Promise<void> {
  unwrap(
    await supabase.rpc('revoke_user_role', { p_user_role_id: userRoleId, ...(reason ? { p_reason: reason } : {}) }),
    'roles.revoke',
  )
}
