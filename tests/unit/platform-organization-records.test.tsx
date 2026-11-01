import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import { OrganizationRecords } from '@/modules/platform/OrganizationRecords'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }))
beforeEach(() => rpc.mockReset())
function show(section = 'security') {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><OrganizationRecords organization="org-a" section={section} /></QueryClientProvider>)
}
it('loads scoped records and paginates on the server', async () => {
  rpc.mockResolvedValue({ data: { rows: [{ id: 'one', email: 'member@example.test', email_verified: true }], total: 26 }, error: null })
  show()
  expect(await screen.findByText('member@example.test')).toBeInTheDocument()
  expect(screen.getByText('Yes')).toBeInTheDocument()
  expect(rpc).toHaveBeenCalledWith('platform_organization_records', { p_organization: 'org-a', p_section: 'security', p_page: 0 })
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  await waitFor(() => expect(rpc).toHaveBeenCalledWith('platform_organization_records', { p_organization: 'org-a', p_section: 'security', p_page: 1 }))
})
it('displays permission errors and offers refresh', async () => {
  rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'Platform permission required' } })
  show('invoices')
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  rpc.mockResolvedValue({ data: { rows: [], total: 0 }, error: null })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(await screen.findByText('No records found.')).toBeInTheDocument()
})
