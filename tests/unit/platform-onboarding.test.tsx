import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ read: vi.fn(), rpc: vi.fn() }))
vi.mock('@/modules/platform/api', () => ({ readPlatform: mocks.read, textValue: String }))
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }))
import { TenantsPage } from '@/modules/organization/TenantsPage'

it('uses verified email lookup and preserves the request reference after a failed create', async () => {
  mocks.read.mockResolvedValue({ rows: [{ id: 'owner-id', verified: true }] })
  mocks.rpc.mockResolvedValueOnce({ data: null, error: new Error('Temporary failure') }).mockResolvedValueOnce({ data: 'new-org', error: null })
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><TenantsPage /></MemoryRouter></QueryClientProvider>)
  fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'New Pharmacy' } })
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  fireEvent.change(screen.getByLabelText('Owner first name'), { target: { value: 'Jane' } })
  fireEvent.change(screen.getByLabelText('Owner last name'), { target: { value: 'Owner' } })
  fireEvent.change(screen.getByLabelText('Owner email'), { target: { value: 'jane@example.com' } })
  fireEvent.click(screen.getByRole('button', { name: 'Verify owner and review' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm and create organization' })).toBeEnabled())
  expect(mocks.read).toHaveBeenCalledWith('owners', 'jane@example.com')
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and create organization' }))
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm and create organization' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and create organization' }))
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2))
  expect(mocks.rpc.mock.calls[0]![1].p_request_id).toBe(mocks.rpc.mock.calls[1]![1].p_request_id)
  expect(mocks.rpc.mock.calls[1]![1].p_owner_user_id).toBe('owner-id')
  await waitFor(() => expect(screen.getByText('Organization created. The owner can now sign in.')).toBeInTheDocument())
})
