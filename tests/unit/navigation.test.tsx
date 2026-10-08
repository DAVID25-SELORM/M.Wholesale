import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/modules/auth/AuthProvider', () => ({ useAuth: () => ({ auth: { status: 'signedIn' }, signOut: vi.fn() }) }))

import { Sidebar } from '@/layouts/Sidebar'
import { BranchSelector } from '@/layouts/Topbar'
import { B2, HQ, makeContext, renderWithApp } from './helpers'

describe('permission-aware navigation', () => {
  it('shows only the admin pages the user may view, and marks future modules as Soon', () => {
    renderWithApp(<Sidebar onNavigate={() => {}} />, {
      context: makeContext({ org_permissions: ['branches.view', 'audit.view'], branch_permissions: {} }),
    })
    const nav = screen.getByRole('navigation', { name: /main navigation/i })
    expect(within(nav).getByRole('link', { name: 'Branches' })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Audit log' })).toBeInTheDocument()
    expect(within(nav).queryByRole('link', { name: 'Users' })).not.toBeInTheDocument()
    expect(within(nav).queryByRole('link', { name: 'Roles & permissions' })).not.toBeInTheDocument()
    expect(within(nav).queryByRole('link', { name: 'Warehouses' })).not.toBeInTheDocument()
    // planned modules are never links
    expect(within(nav).queryByRole('link', { name: 'Products' })).not.toBeInTheDocument()
    expect(within(nav).getAllByText('Soon').length).toBeGreaterThan(0)
  })

  it('treats branch-scoped permission as sufficient to show the page', () => {
    renderWithApp(<Sidebar onNavigate={() => {}} />, {
      context: makeContext({ org_permissions: [], roles: [{ id: 'r', role_code: 'WAREHOUSE_MANAGER', role_name: 'Warehouse Manager', branch_id: HQ }], branch_permissions: { [HQ]: ['warehouses.view'] } }),
    })
    expect(screen.getByRole('link', { name: 'Warehouses' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Branches' })).not.toBeInTheDocument()
  })

  it('shows no administration links for a user with no permissions', () => {
    renderWithApp(<Sidebar onNavigate={() => {}} />, { context: makeContext({ org_permissions: [], branch_permissions: {}, roles: [] }) })
    expect(screen.queryByRole('link', { name: 'Branches' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument()
  })
})

describe('branch selector', () => {
  it('offers "All branches" only to users with organization-wide access', () => {
    renderWithApp(<BranchSelector />)
    const sel = screen.getByLabelText('Branch') as HTMLSelectElement
    expect([...sel.options].map((o) => o.text)).toEqual(['All branches', 'Head Office', 'Kumasi'])
  })

  it('a branch-scoped user can only pick their own branches and starts on one', () => {
    renderWithApp(<BranchSelector />, {
      context: makeContext({
        roles: [{ id: 'r', role_code: 'BRANCH_MANAGER', role_name: 'Branch Manager', branch_id: B2 }],
        org_permissions: [], branch_permissions: { [B2]: ['branches.view'] },
        branches: [{ id: B2, code: 'KUM', name: 'Kumasi', is_head_office: false, is_active: true }],
        profile: { first_name: 'Kofi', last_name: 'Boateng', default_branch_id: null },
      }),
    })
    const sel = screen.getByLabelText('Branch') as HTMLSelectElement
    expect([...sel.options].map((o) => o.text)).toEqual(['Kumasi'])
    expect(sel.value).toBe(B2)
    expect(sel).toBeDisabled() // nothing to choose
  })

  it('switching branch updates the selection', async () => {
    renderWithApp(<BranchSelector />)
    const sel = screen.getByLabelText('Branch') as HTMLSelectElement
    await userEvent.selectOptions(sel, 'Kumasi')
    expect(sel.value).toBe(B2)
  })

  it('ignores a stored selection the user is not allowed to use', () => {
    localStorage.setItem('wps.selectedBranch', '33333333-3333-4333-8333-333333333333')
    renderWithApp(<BranchSelector />, {
      context: makeContext({
        roles: [{ id: 'r', role_code: 'BRANCH_MANAGER', role_name: 'Branch Manager', branch_id: HQ }],
        org_permissions: [], branch_permissions: { [HQ]: ['branches.view'] },
        branches: [{ id: HQ, code: 'HQ', name: 'Head Office', is_head_office: true, is_active: true }],
      }),
    })
    expect((screen.getByLabelText('Branch') as HTMLSelectElement).value).toBe(HQ)
    localStorage.clear()
  })
})
