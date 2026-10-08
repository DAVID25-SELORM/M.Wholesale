import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionContext } from '@/types/domain'
import { makeContext } from './helpers'

const authState = vi.hoisted(() => ({ value: { status: 'signedOut', session: null } as unknown }))
const rpc = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }))
vi.mock('@/lib/env', () => ({ envProblem: null, env: {} }))
vi.mock('@/modules/auth/AuthProvider', () => ({
  useAuth: () => ({ auth: authState.value, signIn: vi.fn(), signOut: vi.fn() }),
}))

import { RequireAuth, RequirePermission } from '@/modules/auth/guards'

function mount(initial = '/secret', ctx?: SessionContext) {
  if (ctx) rpc.mockResolvedValue({ data: ctx, error: null })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/login" element={<p>LOGIN PAGE</p>} />
          <Route path="/access-disabled" element={<p>ACCESS DISABLED PAGE</p>} />
          <Route path="/no-access" element={<p>NO ACCESS PAGE</p>} />
          <Route path="/unauthorized" element={<p>UNAUTHORIZED PAGE</p>} />
          <Route element={<RequireAuth />}>
            <Route element={<RequirePermission anyOf={['audit.view']} />}>
              <Route path="/secret" element={<p>SECRET CONTENT</p>} />
            </Route>
            <Route path="/open" element={<p>OPEN CONTENT</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const signedIn = { status: 'signedIn', session: { user: { id: 'u1' } } }

describe('route protection', () => {
  beforeEach(() => { rpc.mockReset(); authState.value = { status: 'signedOut', session: null } })

  it('sends unauthenticated visitors to the login page and never asks the server for data', async () => {
    mount()
    expect(await screen.findByText('LOGIN PAGE')).toBeInTheDocument()
    expect(screen.queryByText('SECRET CONTENT')).not.toBeInTheDocument()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('shows a loading state while the session is being restored', () => {
    authState.value = { status: 'loading', session: null }
    mount()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('sends inactive users to the access-disabled page', async () => {
    authState.value = signedIn
    mount('/open', makeContext({ status: 'inactive_user' }))
    expect(await screen.findByText('ACCESS DISABLED PAGE')).toBeInTheDocument()
    expect(screen.queryByText('OPEN CONTENT')).not.toBeInTheDocument()
  })

  it('sends users of an inactive organization to the access-disabled page', async () => {
    authState.value = signedIn
    mount('/open', makeContext({ status: 'inactive_organization' }))
    expect(await screen.findByText('ACCESS DISABLED PAGE')).toBeInTheDocument()
  })

  it('sends signed-in users without a profile to the no-access page', async () => {
    authState.value = signedIn
    mount('/open', makeContext({ status: 'no_profile' }))
    expect(await screen.findByText('NO ACCESS PAGE')).toBeInTheDocument()
  })

  it('sends authenticated users without the permission to the unauthorized page', async () => {
    authState.value = signedIn
    mount('/secret', makeContext({ org_permissions: ['branches.view'] }))
    expect(await screen.findByText('UNAUTHORIZED PAGE')).toBeInTheDocument()
    expect(screen.queryByText('SECRET CONTENT')).not.toBeInTheDocument()
  })

  it('lets users with the permission through', async () => {
    authState.value = signedIn
    mount('/secret', makeContext({ org_permissions: ['audit.view'] }))
    expect(await screen.findByText('SECRET CONTENT')).toBeInTheDocument()
  })

  it('shows an error state with retry when the workspace cannot be loaded', async () => {
    authState.value = signedIn
    rpc.mockResolvedValue({ data: null, error: { code: '', message: 'boom' } })
    mount('/open')
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })
})
