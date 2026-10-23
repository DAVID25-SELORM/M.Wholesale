import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Routes, Route } from 'react-router-dom'
import { HQ, B2, makeContext, renderWithApp } from './helpers'

const svc = vi.hoisted(() => ({ getQueue: vi.fn(), getFulfilmentOrder: vi.fn(), getPickLines: vi.fn(), getPackingDetail: vi.fn(), getDispatchQueue: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/services/fulfilment', async orig => ({ ...(await orig<typeof import('@/services/fulfilment')>()), getQueue: svc.getQueue, getFulfilmentOrder: svc.getFulfilmentOrder, getPickLines: svc.getPickLines }))
vi.mock('@/services/packing', async orig => ({ ...(await orig<typeof import('@/services/packing')>()), getPackingDetail: svc.getPackingDetail, getDispatchQueue: svc.getDispatchQueue }))
import { PackingPage, PackingQueuePage } from '@/modules/fulfilment/PackingPage'

const order = { id: 'order-a', order_number: 'FO-1', status: 'PACKING', branch_id: HQ, customer_name: 'Customer A', warehouse_name: 'Main', invoice_number: 'INV-1', invoice_id: 'invoice-a' }
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  svc.getQueue.mockResolvedValue([order, { ...order, id: 'other', order_number: 'OTHER-BRANCH', branch_id: B2 }])
  svc.getDispatchQueue.mockResolvedValue([{ ...order, status: 'PACKED' }])
  svc.getFulfilmentOrder.mockResolvedValue(order)
  svc.getPickLines.mockResolvedValue([])
  svc.getPackingDetail.mockResolvedValue({ packages: [], contents: [], lines: [] })
})
describe('packing and dispatch screens', () => {
  it('filters the packing queue to the selected branch', async () => {
    renderWithApp(<PackingQueuePage />)
    expect(await screen.findByText('FO-1')).toHaveAttribute('href', '/warehouse/packing/order-a')
    expect(screen.queryByText('OTHER-BRANCH')).not.toBeInTheDocument()
  })
  it('uses the dispatch queue and links to delivery tracking', async () => {
    renderWithApp(<PackingQueuePage dispatch />)
    expect(await screen.findByText('FO-1')).toBeInTheDocument()
    expect(svc.getDispatchQueue).toHaveBeenCalled()
    expect(screen.getByRole('link', { name: /track delivery outcomes/ })).toHaveAttribute('href', '/sales/deliveries')
  })
  it('keeps packing mutations unavailable to read-only staff', async () => {
    renderWithApp(<Routes><Route path="/packing/:id" element={<PackingPage />} /></Routes>, { route: '/packing/order-a', context: makeContext({ org_permissions: ['fulfilment.view'] }) })
    expect(await screen.findByText('Quantity reconciliation')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Seal packing' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add package' })).not.toBeInTheDocument()
  })
  it('shows packing controls to authorized packers', async () => {
    renderWithApp(<Routes><Route path="/packing/:id" element={<PackingPage />} /></Routes>, { route: '/packing/order-a', context: makeContext({ org_permissions: ['fulfilment.view', 'packing.work'] }) })
    expect(await screen.findByRole('button', { name: 'Seal packing' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add package' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm packed quantity' })).toBeDisabled()
  })
})
