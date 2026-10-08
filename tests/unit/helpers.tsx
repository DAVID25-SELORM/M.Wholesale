import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui'
import { SessionProvider } from '@/modules/session/SessionProvider'
import type { SessionContext } from '@/types/domain'

export const HQ = '11111111-1111-4111-8111-111111111111'
export const B2 = '22222222-2222-4222-8222-222222222222'

export function makeContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    status: 'ok',
    user_id: '99999999-9999-4999-8999-999999999999',
    profile: { first_name: 'Ada', last_name: 'Mensah', display_name: 'Ada Mensah', default_branch_id: HQ },
    organization: { id: 'org-1', name: 'Acme Pharma', currency_code: 'GHS', timezone: 'Africa/Accra', country: 'GH' },
    roles: [{ id: 'ur-1', role_code: 'OWNER', role_name: 'Owner', branch_id: null }],
    org_permissions: ['branches.view', 'branches.create', 'branches.edit', 'warehouses.view', 'users.view', 'audit.view', 'organizations.view'],
    branch_permissions: {},
    branches: [
      { id: HQ, code: 'HQ', name: 'Head Office', is_head_office: true, is_active: true },
      { id: B2, code: 'KUM', name: 'Kumasi', is_head_office: false, is_active: true },
    ],
    ...overrides,
  }
}

export function renderWithApp(ui: ReactElement, opts: { context?: SessionContext; route?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[opts.route ?? '/']}>
          <SessionProvider context={opts.context ?? makeContext()}>{ui}</SessionProvider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  )
}
