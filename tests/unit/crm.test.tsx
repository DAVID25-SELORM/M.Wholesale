import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { makeContext, renderWithApp } from './helpers'
const db = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: db }))
import { CrmPage } from '@/modules/crm/CrmPage'
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks()
  db.rpc.mockImplementation(async (name: string) => ({ data: name === 'crm_workspace' ? { rows: [], territories: [], profiles: [], customers: [], representatives: [] } : 'saved', error: null }))
})
it('persists a territory through the authorized RPC', async () => {
  const user = userEvent.setup()
  renderWithApp(<CrmPage kind="territories" />, { context: makeContext({ org_permissions: ['crm.view', 'crm.manage'] }) })
  await user.click(screen.getByRole('button', { name: 'New record' }))
  await user.type(screen.getByLabelText('Territory name'), 'North')
  await user.type(screen.getByLabelText('Area covered'), 'Northern region')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save record' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: 'Save record' }))
  await waitFor(() => expect(db.rpc).toHaveBeenCalledWith('save_crm_record', { p_kind: 'territories', p_id: null, p_data: { name: 'North', area: 'Northern region', is_active: true } }))
})
it('does not offer create actions to a read-only user', () => {
  renderWithApp(<CrmPage kind="visits" />, { context: makeContext({ org_permissions: ['crm.view'] }) })
  expect(screen.queryByRole('button', { name: 'New record' })).not.toBeInTheDocument()
})
