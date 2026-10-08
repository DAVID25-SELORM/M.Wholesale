import { describe, expect, it } from 'vitest'
import { createAbility } from '@/modules/session/ability'
import { B2, HQ, makeContext } from './helpers'

describe('createAbility (UX permission model)', () => {
  it('organization-wide permissions apply to every branch', () => {
    const a = createAbility(makeContext())
    expect(a.can('branches.create')).toBe(true)
    expect(a.can('branches.edit', B2)).toBe(true)
    expect(a.canAnywhere('audit.view')).toBe(true)
    expect(a.can('roles.manage')).toBe(false)
    expect(a.hasOrgWideAccess).toBe(true)
  })

  it('branch-scoped permissions only apply to that branch', () => {
    const a = createAbility(makeContext({
      roles: [{ id: 'r', role_code: 'BRANCH_MANAGER', role_name: 'Branch Manager', branch_id: HQ }],
      org_permissions: [],
      branch_permissions: { [HQ]: ['warehouses.create', 'warehouses.edit'] },
    }))
    expect(a.can('warehouses.edit', HQ)).toBe(true)
    expect(a.can('warehouses.edit', B2)).toBe(false)
    expect(a.can('warehouses.edit')).toBe(false) // org-wide not held
    expect(a.canAnywhere('warehouses.edit')).toBe(true)
    expect(a.hasOrgWideAccess).toBe(false)
  })

  it('grants nothing for inactive or missing sessions', () => {
    for (const ctx of [null, undefined, makeContext({ status: 'inactive_user' }), makeContext({ status: 'no_profile' })]) {
      const a = createAbility(ctx)
      expect(a.canAnywhere('branches.view')).toBe(false)
      expect(a.canAnyOf(['branches.view', 'audit.view'])).toBe(false)
      expect(a.hasOrgWideAccess).toBe(false)
    }
  })

  it('canAnyOf is true when any permission is held', () => {
    const a = createAbility(makeContext())
    expect(a.canAnyOf(['roles.manage', 'audit.view'])).toBe(true)
    expect(a.canAnyOf(['roles.manage', 'settings.manage'])).toBe(false)
  })
})
