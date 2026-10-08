import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const insert = vi.hoisted(() => vi.fn())
const createLocation = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/services/branches', async (orig) => ({
  ...(await orig<typeof import('@/services/branches')>()),
  createBranch: insert,
  updateBranch: vi.fn(),
}))
vi.mock('@/services/warehouses', async (orig) => ({
  ...(await orig<typeof import('@/services/warehouses')>()),
  createLocation,
}))

import { BranchForm } from '@/modules/branches/BranchForm'
import { LocationForm } from '@/modules/warehouses/LocationForm'
import { entityCode, validate } from '@/lib/validation'
import { renderWithApp } from './helpers'

describe('administration forms', () => {
  beforeEach(() => { insert.mockReset(); createLocation.mockReset() })

  it('branch form validates before calling the server', async () => {
    renderWithApp(<BranchForm open branch={null} canEdit onClose={() => {}} />)
    await userEvent.type(screen.getByLabelText(/^Code/), 'bad code!')
    await userEvent.click(screen.getByRole('button', { name: 'Create branch' }))
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0)
    expect(screen.getByText(/no spaces/i)).toBeInTheDocument()
    expect(screen.getByText('Name is required')).toBeInTheDocument()
    expect(insert).not.toHaveBeenCalled()
  })

  it('branch form submits normalised values and never sends organization_id', async () => {
    insert.mockResolvedValue(undefined)
    const onClose = vi.fn()
    renderWithApp(<BranchForm open branch={null} canEdit onClose={onClose} />)
    await userEvent.type(screen.getByLabelText(/^Code/), 'kum')
    await userEvent.type(screen.getByLabelText(/^Name/), '  Kumasi Branch ')
    await userEvent.click(screen.getByRole('button', { name: 'Create branch' }))
    await waitFor(() => expect(insert).toHaveBeenCalledTimes(1))
    const sent = insert.mock.calls[0]![0]
    expect(sent).toMatchObject({ code: 'KUM', name: 'Kumasi Branch', is_active: true })
    expect(sent).not.toHaveProperty('organization_id')
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('shows the server message (duplicate code) inside the form and keeps it open', async () => {
    insert.mockRejectedValue({ code: '23505', message: 'duplicate key value violates unique constraint "branches_org_code_key"' })
    const onClose = vi.fn()
    renderWithApp(<BranchForm open branch={null} canEdit onClose={onClose} />)
    await userEvent.type(screen.getByLabelText(/^Code/), 'HQ')
    await userEvent.type(screen.getByLabelText(/^Name/), 'Dup')
    await userEvent.click(screen.getByRole('button', { name: 'Create branch' }))
    expect(await screen.findByText(/already in use/i)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('is read-only (no submit button) for users who cannot edit', () => {
    renderWithApp(<BranchForm open branch={null} canEdit={false} onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: /create branch/i })).not.toBeInTheDocument()
    expect(screen.getByLabelText(/^Code/)).toHaveAttribute('readonly')
  })

  it('location form validates the picking sequence and sends a number', async () => {
    createLocation.mockResolvedValue(undefined)
    renderWithApp(<LocationForm open location={null} warehouseId="w1" canEdit onClose={() => {}} />)
    await userEvent.type(screen.getByLabelText(/^Code/), 'a-01')
    const seq = screen.getByLabelText(/Pick order/)
    await userEvent.clear(seq)
    await userEvent.type(seq, '-4')
    await userEvent.click(screen.getByRole('button', { name: 'Create location' }))
    expect(await screen.findByText(/0 or more/i)).toBeInTheDocument()
    expect(createLocation).not.toHaveBeenCalled()

    await userEvent.clear(seq)
    await userEvent.type(seq, '25')
    await userEvent.click(screen.getByRole('button', { name: 'Create location' }))
    await waitFor(() => expect(createLocation).toHaveBeenCalledTimes(1))
    expect(createLocation.mock.calls[0]![0]).toMatchObject({ warehouse_id: 'w1', code: 'A-01', picking_sequence: 25 })
  })
})

describe('entity code validation', () => {
  it('accepts upper-cased codes and rejects spaces/symbols', () => {
    expect(validate(entityCode, 'hq-1')).toEqual({ ok: true, data: 'HQ-1' })
    expect(validate(entityCode, 'a b').ok).toBe(false)
    expect(validate(entityCode, '').ok).toBe(false)
    expect(validate(entityCode, 'X'.repeat(33)).ok).toBe(false)
  })
})
