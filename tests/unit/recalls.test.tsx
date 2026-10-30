import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeContext, renderWithApp } from './helpers'
const svc = vi.hoisted(() => ({ listRecallRecoveries: vi.fn(), recordRecallRecovery: vi.fn(), listRecalls: vi.fn(), listRecallScope: vi.fn(), recallBatchOptions: vi.fn(), quarantineRecallBatch: vi.fn(), recallCustomerExposure: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/services/recalls', async orig => ({ ...(await orig<typeof import('@/services/recalls')>()), ...svc }))
import { RecallsPage } from '@/modules/inventory/RecallsPage'

beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks()
  svc.listRecalls.mockResolvedValue([{ id: 'recall-1', recall_number: 'REC-1', title: 'Affected medicine', instructions: 'Isolate the batch', source: 'INTERNAL', recall_class: 'II', status: 'OPEN' }])
  svc.listRecallScope.mockResolvedValue([{ id: 'scope-1', batch_id: 'batch-1', quarantined_at: null }])
  svc.recallBatchOptions.mockResolvedValue([{ id: 'batch-1', product_name: 'Medicine A', sku: 'MED-A', batch_number: 'LOT-A', expiry_date: '2030-12-31' }])
  svc.quarantineRecallBatch.mockResolvedValue({ quarantined: 12 })
  svc.recallCustomerExposure.mockResolvedValue([])
  svc.listRecallRecoveries.mockResolvedValue([])
  svc.recordRecallRecovery.mockResolvedValue('recovery')
})
describe('recall screen', () => {
  it('requires explicit recall selection and keeps auditors read-only', async () => {
    const user = userEvent.setup()
    renderWithApp(<RecallsPage />, { context: makeContext({ org_permissions: ['recalls.view'] }) })
    expect(await screen.findByRole('button', { name: 'REC-1' })).toBeInTheDocument()
    expect(svc.listRecallScope).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'REC-1' }))
    expect(await screen.findByText(/Medicine A \/ LOT-A/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New recall' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Quarantine batch' })).not.toBeInTheDocument()
  })
  it('quarantines the selected scope only after a reason is provided', async () => {
    const user = userEvent.setup()
    renderWithApp(<RecallsPage />, { context: makeContext({ org_permissions: ['recalls.view', 'recalls.manage'] }) })
    await user.click(await screen.findByRole('button', { name: 'REC-1' }))
    const button = await screen.findByRole('button', { name: 'Quarantine batch' })
    expect(button).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close recall' })).toBeDisabled()
    await user.type(screen.getByLabelText('Quarantine reason'), 'Recall inspection')
    await user.click(button)
    expect(svc.quarantineRecallBatch).toHaveBeenCalledWith('scope-1', 'Recall inspection')
  })
})

it('records the explicitly selected invoice batch when an invoice has multiple recalled batches', async () => {
  const user = userEvent.setup()
  svc.listRecallScope.mockResolvedValue([{ id: 'scope-1', batch_id: 'batch-1' }, { id: 'scope-2', batch_id: 'batch-2' }])
  svc.recallCustomerExposure.mockResolvedValue([
    { invoice_id: 'invoice', invoice_number: 'INV-1', batch_id: 'batch-1', batch_number: 'LOT-A', customer_name: 'Customer' },
    { invoice_id: 'invoice', invoice_number: 'INV-1', batch_id: 'batch-2', batch_number: 'LOT-B', customer_name: 'Customer' },
  ])
  renderWithApp(<RecallsPage />, { context: makeContext({ org_permissions: ['recalls.view', 'recalls.manage'] }) })
  await user.click(await screen.findByRole('button', { name: 'REC-1' }))
  await user.selectOptions(await screen.findByLabelText('Invoice and batch'), 'invoice/batch-2')
  await user.type(screen.getByLabelText('Quantity'), '2')
  await user.type(screen.getByLabelText(/^Notes/), 'Customer contacted')
  await user.click(screen.getByRole('button', { name: 'Save recovery record' }))
  await waitFor(() => expect(svc.recordRecallRecovery).toHaveBeenCalledWith('scope-2', 'invoice', 2, 'CONTACTED', 'Customer contacted'))
})