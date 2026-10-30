import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { OrganizationDetail } from '@/modules/platform/OrganizationDetail'

it('separates organization details and reports active usage from records', () => {
  const edit = vi.fn()
  const profile = { id: 'org', name: 'Example Pharmacy' }
  render(<OrganizationDetail onEdit={edit} data={{ profile, users: [{ id: 'a', name: 'Active member', active: true }, { id: 'b', name: 'Inactive member', active: false }], branches: [], warehouses: [], subscription: null }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }))
  expect(edit).toHaveBeenCalledWith(profile)
  fireEvent.click(screen.getByRole('tab', { name: 'Users' }))
  expect(screen.getByText('Inactive member')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('tab', { name: 'Usage' }))
  expect(screen.getByText('1')).toBeInTheDocument()
  expect(screen.getByText('2 total')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('tab', { name: 'Subscription' }))
  expect(screen.getByText('No subscription assigned.')).toBeInTheDocument()
})
