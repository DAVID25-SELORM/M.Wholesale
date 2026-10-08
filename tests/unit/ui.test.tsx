import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const signIn = vi.hoisted(() => vi.fn())
const authState = vi.hoisted(() => ({ value: { status: 'signedOut', session: null } as unknown }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/lib/env', () => ({ envProblem: null, env: {} }))
vi.mock('@/modules/auth/AuthProvider', () => ({ useAuth: () => ({ auth: authState.value, signIn, signOut: vi.fn() }) }))

import { DataTable, Pagination, type Column } from '@/components/ui'
import { LoginPage } from '@/modules/auth/pages'

interface Row { id: string; name: string }
const columns: Column<Row>[] = [{ key: 'n', header: 'Name', sortKey: 'name', render: (r) => r.name }]

describe('DataTable states', () => {
  it('shows a loading state before the first data arrives', () => {
    render(<DataTable columns={columns} rows={undefined} rowKey={(r) => r.id} loading />)
    expect(screen.getByRole('status')).toHaveTextContent(/loading/i)
  })

  it('shows an error with a retry action', async () => {
    const retry = vi.fn()
    render(<DataTable columns={columns} rows={undefined} rowKey={(r) => r.id} error="Cannot reach the server." onRetry={retry} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot reach the server.')
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(retry).toHaveBeenCalled()
  })

  it('shows an empty state', () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} emptyTitle="No branches yet" />)
    expect(screen.getByText('No branches yet')).toBeInTheDocument()
  })

  it('renders rows and reports sort changes', async () => {
    const onSort = vi.fn()
    render(<DataTable columns={columns} rows={[{ id: '1', name: 'Alpha' }]} rowKey={(r) => r.id} sort={{ key: 'name', direction: 'asc' }} onSortChange={onSort} />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Name' }))
    expect(onSort).toHaveBeenCalledWith({ key: 'name', direction: 'desc' })
  })
})

describe('Pagination', () => {
  it('disables Prev on the first page and Next on the last', () => {
    const { rerender } = render(<Pagination page={0} pageSize={10} total={25} onPageChange={() => {}} />)
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /next/i })).toBeEnabled()
    expect(screen.getByText('1–10 of 25')).toBeInTheDocument()
    rerender(<Pagination page={2} pageSize={10} total={25} onPageChange={() => {}} />)
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
  })

  it('works without a total (audit log style)', () => {
    render(<Pagination page={1} pageSize={25} hasNext onPageChange={() => {}} />)
    expect(screen.getByText('Page 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /next/i })).toBeEnabled()
  })
})

describe('login page', () => {
  beforeEach(() => { signIn.mockReset(); authState.value = { status: 'signedOut', session: null } })
  const mount = () => render(<MemoryRouter><LoginPage /></MemoryRouter>)

  it('requires email and password before calling the server', async () => {
    mount()
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/enter your email and password/i)
    expect(signIn).not.toHaveBeenCalled()
  })

  it('shows a safe message for bad credentials and does not leak details', async () => {
    signIn.mockRejectedValue(new Error('Incorrect email or password.'))
    mount()
    await userEvent.type(screen.getByLabelText(/^Email/), 'a@b.test')
    await userEvent.type(screen.getByLabelText(/^Password/), 'wrong-password')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password.')
  })

  it('has no way to sign up (accounts are created by administrators)', () => {
    mount()
    expect(screen.queryByText(/sign up|create account|register/i)).not.toBeInTheDocument()
    expect(screen.getByText(/created by your administrator/i)).toBeInTheDocument()
  })
})
