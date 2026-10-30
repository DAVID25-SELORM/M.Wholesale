import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { makeContext, renderWithApp } from './helpers'
const svc = vi.hoisted(() => ({ listCustomers: vi.fn(), getCustomerCredit: vi.fn(), update: vi.fn(), single: vi.fn() }))
vi.mock('@/services/customers', () => svc)
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({ update: svc.update }) } }))
import { CreditControlPage } from '@/modules/sales/CreditControlPage'
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks()
  svc.listCustomers.mockResolvedValue({ rows: [{ id: 'customer', code: 'C1', name: 'Clinic', credit_limit: 100, payment_terms_days: 30, on_hold: false, hold_reason: null }], hasNext: false })
  svc.getCustomerCredit.mockResolvedValue({ outstanding: 25, overdue: 0, available: 75 })
  svc.update.mockReturnValue({ eq: () => ({ select: () => ({ single: svc.single }) }) })
  svc.single.mockResolvedValue({ data: { id: 'customer' }, error: null })
})
it('persists credit hold and terms for an authorized editor', async () => {
  const user = userEvent.setup()
  renderWithApp(<CreditControlPage />, { context: makeContext({ org_permissions: ['customers.view', 'customers.edit', 'receipts.view'] }) })
  await user.click(await screen.findByRole('button', { name: 'Review C1' }))
  await user.selectOptions(screen.getByLabelText('Credit hold'), 'yes')
  await user.type(screen.getByLabelText('Hold reason'), 'Account review')
  await user.click(screen.getByRole('button', { name: 'Save credit controls' }))
  await waitFor(() => expect(svc.update).toHaveBeenCalledWith({ credit_limit: 100, payment_terms_days: 30, on_hold: true, hold_reason: 'Account review' }))
})
it('does not offer saving to a read-only user', async () => {
  const user = userEvent.setup()
  renderWithApp(<CreditControlPage />, { context: makeContext({ org_permissions: ['customers.view'] }) })
  await user.click(await screen.findByRole('button', { name: 'Review C1' }))
  expect(screen.queryByRole('button', { name: 'Save credit controls' })).not.toBeInTheDocument()
  expect(svc.getCustomerCredit).not.toHaveBeenCalled()
})
