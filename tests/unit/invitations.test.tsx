import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authState = vi.hoisted(() => ({ value: { status: 'signedOut', session: null } as unknown }))
const updateUser = vi.hoisted(() => vi.fn())
const resetPasswordForEmail = vi.hoisted(() => vi.fn())
const inviteUser = vi.hoisted(() => vi.fn())
const listUsers = vi.hoisted(() => vi.fn())
const navigate = vi.hoisted(() => vi.fn())
const ROLE_ID = '3f6f708c-dd50-4026-b94d-ef651bddd692'

vi.mock('@/lib/supabase', () => ({ supabase: { auth: { updateUser, resetPasswordForEmail } } }))
vi.mock('@/lib/env', () => ({ envProblem: null, env: {} }))
vi.mock('@/modules/auth/AuthProvider', () => ({ useAuth: () => ({ auth: authState.value, signIn: vi.fn(), signOut: vi.fn() }) }))
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<typeof import('react-router-dom')>()), useNavigate: () => navigate }))
vi.mock('@/services/users', async (orig) => ({
  ...(await orig<typeof import('@/services/users')>()),
  inviteUser, listUsers, resendInvitation: vi.fn(),
}))
vi.mock('@/services/roles', () => ({ listAssignableRoles: async () => [{ id: ROLE_ID, code: 'CASHIER', name: 'Cashier', description: null }] }))
vi.mock('@/services/branches', async (orig) => ({
  ...(await orig<typeof import('@/services/branches')>()),
  listBranchOptions: async () => [{ id: '27099ab0-e6c9-4c1b-8556-6dd777298ed3', code: 'KUM', name: 'Kumasi', is_active: true }],
}))

import { ToastProvider } from '@/components/ui'
import { ForgotPasswordPage, SetPasswordPage, passwordSchema } from '@/modules/auth/PasswordPages'
import { InviteUserDialog } from '@/modules/users/InviteUserDialog'
import { UsersPage } from '@/modules/users/UsersPage'
import { makeContext, renderWithApp } from './helpers'

const signedIn = { status: 'signedIn', session: { user: { id: 'u1' } } }

describe('password policy', () => {
  it('requires 12+ chars with upper, lower and a digit', () => {
    for (const bad of ['short1A', 'alllowercase123456', 'ALLUPPERCASE123456', 'NoDigitsHereAtAll']) {
      expect(passwordSchema.safeParse(bad).success, bad).toBe(false)
    }
    expect(passwordSchema.safeParse('Correct-Horse-9').success).toBe(true)
  })
})

describe('SetPasswordPage (invitation / reset link landing)', () => {
  beforeEach(() => { updateUser.mockReset(); navigate.mockReset(); authState.value = signedIn })
  const mount = (mode: 'invite' | 'reset' = 'invite') =>
    render(<ToastProvider><MemoryRouter><SetPasswordPage mode={mode} /></MemoryRouter></ToastProvider>)

  it('explains an invalid or expired link when there is no session', () => {
    authState.value = { status: 'signedOut', session: null }
    mount()
    expect(screen.getByText(/no longer valid/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /reset my password/i })).toBeInTheDocument()
    expect(screen.queryByLabelText(/new password/i)).not.toBeInTheDocument()
  })

  it('validates strength and confirmation before calling the server', async () => {
    mount()
    await userEvent.type(screen.getByLabelText(/^New password/), 'weak')
    await userEvent.type(screen.getByLabelText(/^Confirm password/), 'different')
    await userEvent.click(screen.getByRole('button', { name: /save password/i }))
    expect(await screen.findByText(/at least 12 characters\./i)).toBeInTheDocument()
    expect(screen.getByText(/do not match/i)).toBeInTheDocument()
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('saves a valid password and continues into the app', async () => {
    updateUser.mockResolvedValue({ error: null })
    mount()
    await userEvent.type(screen.getByLabelText(/^New password/), 'Correct-Horse-9')
    await userEvent.type(screen.getByLabelText(/^Confirm password/), 'Correct-Horse-9')
    await userEvent.click(screen.getByRole('button', { name: /save password/i }))
    await waitFor(() => expect(updateUser).toHaveBeenCalledWith({ password: 'Correct-Horse-9' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/', { replace: true }))
  })

  it('shows the server message when the password is rejected', async () => {
    updateUser.mockResolvedValue({ error: { message: 'New password should be different from the old password.' } })
    mount('reset')
    await userEvent.type(screen.getByLabelText(/^New password/), 'Correct-Horse-9')
    await userEvent.type(screen.getByLabelText(/^Confirm password/), 'Correct-Horse-9')
    await userEvent.click(screen.getByRole('button', { name: /save password/i }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe('ForgotPasswordPage', () => {
  beforeEach(() => { resetPasswordForEmail.mockReset(); authState.value = { status: 'signedOut', session: null } })
  const mount = () => render(<MemoryRouter><ForgotPasswordPage /></MemoryRouter>)

  it('gives the same answer whether or not the account exists', async () => {
    resetPasswordForEmail.mockResolvedValue({ error: { message: 'User not found' } })
    mount()
    await userEvent.type(screen.getByLabelText(/^Email/), 'nobody@example.com')
    await userEvent.click(screen.getByRole('button', { name: /send reset link/i }))
    expect(await screen.findByText(/if an account exists/i)).toBeInTheDocument()
  })

  it('reports throttling because the person can act on it', async () => {
    resetPasswordForEmail.mockResolvedValue({ error: { message: 'email rate limit exceeded' } })
    mount()
    await userEvent.type(screen.getByLabelText(/^Email/), 'a@b.test')
    await userEvent.click(screen.getByRole('button', { name: /send reset link/i }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  it('validates the email first', async () => {
    mount()
    await userEvent.type(screen.getByLabelText(/^Email/), 'nope')
    await userEvent.click(screen.getByRole('button', { name: /send reset link/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid email/i)
    expect(resetPasswordForEmail).not.toHaveBeenCalled()
  })
})

describe('InviteUserDialog', () => {
  beforeEach(() => inviteUser.mockReset())

  it('validates before sending', async () => {
    renderWithApp(<InviteUserDialog open onClose={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /send invitation/i }))
    expect(await screen.findByText('Email is required')).toBeInTheDocument()
    expect(screen.getByText('Choose a role')).toBeInTheDocument()
    expect(inviteUser).not.toHaveBeenCalled()
  })

  it('sends the invitation with the chosen role and scope', async () => {
    inviteUser.mockResolvedValue(undefined)
    const onClose = vi.fn()
    renderWithApp(<InviteUserDialog open onClose={onClose} />)
    await userEvent.type(screen.getByLabelText(/^Email/), 'esi@example.com')
    await userEvent.type(screen.getByLabelText(/^First name/), 'Esi')
    await userEvent.type(screen.getByLabelText(/^Last name/), 'Appiah')
    await screen.findByRole('option', { name: 'Cashier' })
    await userEvent.selectOptions(screen.getByLabelText(/^Role/), 'Cashier')
    await userEvent.selectOptions(screen.getByLabelText(/Applies to/), 'Only Kumasi')
    await userEvent.click(screen.getByRole('button', { name: /send invitation/i }))
    await waitFor(() => expect(inviteUser).toHaveBeenCalledTimes(1))
    expect(inviteUser.mock.calls[0]![0]).toMatchObject({
      email: 'esi@example.com', first_name: 'Esi', last_name: 'Appiah', role_id: ROLE_ID, branch_id: '27099ab0-e6c9-4c1b-8556-6dd777298ed3',
    })
    expect(inviteUser.mock.calls[0]![0]).not.toHaveProperty('organization_id')
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})

describe('Users page invite entry point', () => {
  beforeEach(() => listUsers.mockResolvedValue({ rows: [], total: 0, hasNext: false }))

  it('shows "Invite user" only to people holding users.invite', async () => {
    const { unmount } = renderWithApp(<UsersPage />, { context: makeContext({ org_permissions: ['users.view', 'users.invite'] }) })
    expect(await screen.findByRole('button', { name: /invite user/i })).toBeInTheDocument()
    unmount()
    renderWithApp(<UsersPage />, { context: makeContext({ org_permissions: ['users.view'] }) })
    await screen.findByText('Users')
    expect(screen.queryByRole('button', { name: /invite user/i })).not.toBeInTheDocument()
  })
})
