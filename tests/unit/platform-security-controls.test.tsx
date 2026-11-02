import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import { RenewalScheduler } from '@/modules/platform/RenewalScheduler'
import { UserSessions } from '@/modules/platform/UserSessions'
import { writePlatform } from '@/modules/platform/api'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }))
beforeEach(() => rpc.mockReset())
it('maps renewal and revocation actions to their guarded APIs', async () => {
  rpc.mockResolvedValue({ data: null, error: null })
  await writePlatform('subscription.auto_enable', { organization_id: 'org' }, 'Enable scheduled billing')
  expect(rpc).toHaveBeenLastCalledWith('platform_set_auto_renew', { p_organization: 'org', p_enabled: true, p_reason: 'Enable scheduled billing' })
  await writePlatform('subscription.auto_disable', { organization_id: 'org' }, 'Disable scheduled billing')
  expect(rpc).toHaveBeenLastCalledWith('platform_set_auto_renew', { p_organization: 'org', p_enabled: false, p_reason: 'Disable scheduled billing' })
  await writePlatform('user.revoke_sessions', { id: 'user' }, 'Security access reset')
  expect(rpc).toHaveBeenLastCalledWith('platform_revoke_sessions', { p_user: 'user', p_reason: 'Security access reset' })
})
function wrap(element: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{element}</QueryClientProvider>)
}
it('does not claim scheduling works when the job is absent', async () => {
  rpc.mockResolvedValue({ data: { scheduled: false, enabled_subscriptions: 2, failed_subscriptions: 1 }, error: null })
  wrap(<RenewalScheduler />)
  expect(await screen.findByText(/scheduler is not installed/)).toBeInTheDocument()
  expect(screen.getByText(/No payment is collected/)).toBeInTheDocument()
})
it('shows retained authentication events and revoked session status', async () => {
  rpc.mockResolvedValue({ data: { sessions_available: true, history_available: true, sessions: [{ id: 's', created_at: '2026-11-01', revoked: true }], events: [{ id: 'e', action: 'login', created_at: '2026-11-01' }] }, error: null })
  wrap(<UserSessions user="member" onClose={() => undefined} />)
  expect(await screen.findByText('ERP access revoked')).toBeInTheDocument()
  expect(screen.getByText('login')).toBeInTheDocument()
  expect(rpc).toHaveBeenCalledWith('platform_user_sessions', { p_user: 'member' })
})
