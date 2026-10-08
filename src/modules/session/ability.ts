import type { SessionContext } from '@/types/domain'

/**
 * UX-only permission model derived from the server's get_session_context().
 * It decides what to SHOW. It is never a security boundary: every read and write is
 * independently authorized by the database (RLS + guarded RPCs).
 */
export interface Ability {
  /** Holds the permission organization-wide, or (with branchId) for that branch. */
  can: (permission: string, branchId?: string | null) => boolean
  /** Holds the permission in any scope. */
  canAnywhere: (permission: string) => boolean
  canAnyOf: (permissions: readonly string[]) => boolean
  /** At least one role assignment is organization-wide (user may work across all branches). */
  hasOrgWideAccess: boolean
}

export function createAbility(ctx: SessionContext | null | undefined): Ability {
  const orgPerms = new Set(ctx?.status === 'ok' ? (ctx.org_permissions ?? []) : [])
  const branchPerms = new Map<string, Set<string>>(
    ctx?.status === 'ok'
      ? Object.entries(ctx.branch_permissions ?? {}).map(([id, codes]) => [id, new Set(codes)] as const)
      : [],
  )
  const orgWide = ctx?.status === 'ok' && (ctx.roles ?? []).some((r) => r.branch_id === null)

  const can: Ability['can'] = (permission, branchId) => {
    if (orgPerms.has(permission)) return true
    return branchId ? (branchPerms.get(branchId)?.has(permission) ?? false) : false
  }
  const canAnywhere: Ability['canAnywhere'] = (permission) => {
    if (orgPerms.has(permission)) return true
    for (const set of branchPerms.values()) if (set.has(permission)) return true
    return false
  }
  return {
    can,
    canAnywhere,
    canAnyOf: (permissions) => permissions.some(canAnywhere),
    hasOrgWideAccess: orgWide,
  }
}
