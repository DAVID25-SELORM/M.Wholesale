import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Route, Routes } from 'react-router-dom'
import { HQ, B2, makeContext, renderWithApp } from './helpers'
const svc = vi.hoisted(() => ({ listRuns: vi.fn(), runStops: vi.fn(), runOptions: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/services/runs', async orig => ({ ...(await orig<typeof import('@/services/runs')>()), ...svc }))
import { DeliveryRunPage, DeliveryRunsPage } from '@/modules/fleet/DeliveryRunsPage'
const run = { id: 'run-a', branch_id: HQ, run_number: 'RUN-1', run_date: '2026-10-23', status: 'ON_ROAD', driver_name: 'Driver A', vehicle_number: 'VAN-1', capacity_packages: 20, capacity_kg: 200, refrigerated: true, stop_count: 1 }
const stop = { id: 'stop-a', position: 1, status: 'PENDING', package_count: 2, weight_kg: 10, cold_chain: true, loaded_at: '2026-10-23', customer_name: 'Customer A', note_number: 'DN-1', invoice_number: 'INV-1', balance_due: 20, currency_code: 'GHS', delivery_address: 'Address', contact_name: 'Contact', contact_phone: '123' }
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks()
  svc.listRuns.mockResolvedValue([run, { ...run, id: 'other', run_number: 'OTHER', branch_id: B2 }])
  svc.runStops.mockResolvedValue([stop]); svc.runOptions.mockResolvedValue({ drivers: [], vehicles: [], notes: [] })
})
describe('delivery run screens', () => {
  it('shows the selected branch and offers planning to managers', async () => {
    renderWithApp(<DeliveryRunsPage />, { context: makeContext({ org_permissions: ['runs.view', 'runs.manage'] }) })
    expect(await screen.findByText('RUN-1')).toHaveAttribute('href', '/delivery/runs/run-a')
    expect(screen.queryByText('OTHER')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New run' })).toBeInTheDocument()
  })
  it('does not offer planning to drivers', async () => {
    renderWithApp(<DeliveryRunsPage />, { context: makeContext({ org_permissions: ['runs.drive'] }) })
    expect(await screen.findByText('RUN-1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New run' })).not.toBeInTheDocument()
  })
  it('offers outcome recording to the driver without dispatch or planning controls', async () => {
    renderWithApp(<Routes><Route path="/delivery/runs/:id" element={<DeliveryRunPage />} /></Routes>, { route: '/delivery/runs/run-a', context: makeContext({ org_permissions: ['runs.drive'] }) })
    expect(await screen.findByRole('button', { name: 'Record delivery outcome' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dispatch run' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add stop' })).not.toBeInTheDocument()
    expect(screen.getByText('Amount due: GHS 20.00')).toBeInTheDocument()
  })
  it('keeps auditors read-only', async () => {
    renderWithApp(<Routes><Route path="/delivery/runs/:id" element={<DeliveryRunPage />} /></Routes>, { route: '/delivery/runs/run-a', context: makeContext({ org_permissions: ['runs.view'] }) })
    expect(await screen.findByText('1. Customer A')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Record delivery outcome' })).not.toBeInTheDocument()
  })
  it('blocks dispatch until every stop is loaded', async () => {
    svc.listRuns.mockResolvedValue([{ ...run, status: 'LOADING' }]); svc.runStops.mockResolvedValue([{ ...stop, loaded_at: null }])
    renderWithApp(<Routes><Route path="/delivery/runs/:id" element={<DeliveryRunPage />} /></Routes>, { route: '/delivery/runs/run-a', context: makeContext({ org_permissions: ['runs.view', 'runs.manage'] }) })
    expect(await screen.findByRole('button', { name: 'Dispatch run' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Confirm loaded packages' })).toBeInTheDocument()
  })
})
