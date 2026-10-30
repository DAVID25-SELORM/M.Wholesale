import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { HQ, makeContext, renderWithApp } from './helpers'
const svc = vi.hoisted(() => ({ listPurchaseRequests: vi.fn(), requestProducts: vi.fn(), createPurchaseRequest: vi.fn(), submitPurchaseRequest: vi.fn(), decidePurchaseRequest: vi.fn(), cancelPurchaseRequest: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/services/purchaseRequests', () => svc)
import { PurchaseRequestsPage } from '@/modules/purchasing/PurchaseRequestsPage'
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks()
  svc.listPurchaseRequests.mockResolvedValue([])
  svc.requestProducts.mockResolvedValue([{ id: 'product', sku: 'MED', brand_name: 'Medicine' }])
})
it('saves entered request lines and retains them when persistence fails', async () => {
  const user = userEvent.setup()
  svc.createPurchaseRequest.mockRejectedValueOnce(new Error('Save failed')).mockResolvedValueOnce('request')
  renderWithApp(<PurchaseRequestsPage />, { context: makeContext({ org_permissions: ['purchasing.request'] }) })
  await user.selectOptions(screen.getByLabelText('Request branch'), HQ)
  await screen.findByRole('option', { name: 'MED / Medicine' })
  await user.selectOptions(screen.getByLabelText('Product'), 'product')
  await user.clear(screen.getByLabelText('Base-unit quantity'))
  await user.type(screen.getByLabelText('Base-unit quantity'), '3')
  await user.click(screen.getByRole('button', { name: 'Add line' }))
  await user.click(screen.getByRole('button', { name: 'Save draft' }))
  await waitFor(() => expect(svc.createPurchaseRequest).toHaveBeenCalledWith(HQ, '', '', [{ product_id: 'product', quantity: 3 }]))
  expect(screen.getByRole('button', { name: 'Remove MED / Medicine' })).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: 'Save draft' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove MED / Medicine' })).not.toBeInTheDocument())
})
