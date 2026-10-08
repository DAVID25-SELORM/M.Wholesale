import { supabase } from '@/lib/supabase'
import type { Tables } from '@/types/domain'
import { unwrap } from './common'

export type Role = Tables<'roles'>
export type Permission = Tables<'permissions'>
export interface RoleWithPermissions extends Role {
  role_permissions: { permission: Pick<Permission, 'code' | 'module' | 'action' | 'description'> | null }[]
}

/** Active roles (name only) - used by assignment pickers. */
export async function listAssignableRoles(): Promise<Pick<Role, 'id' | 'code' | 'name' | 'description'>[]> {
  return unwrap(
    await supabase.from('roles').select('id, code, name, description').eq('is_active', true).order('name'),
    'roles.assignable',
  )
}

/** Roles with their permission lists (requires roles.view; otherwise RLS returns no permission rows). */
export async function listRolesWithPermissions(): Promise<RoleWithPermissions[]> {
  const rows = unwrap(
    await supabase
      .from('roles')
      .select('*, role_permissions(permission:permissions(code, module, action, description))')
      .order('name'),
    'roles.list',
  )
  return rows as unknown as RoleWithPermissions[]
}

export async function listPermissions(): Promise<Permission[]> {
  return unwrap(await supabase.from('permissions').select('*').order('module').order('action'), 'permissions.list')
}
