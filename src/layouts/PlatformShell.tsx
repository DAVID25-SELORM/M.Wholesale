import { useQuery } from '@tanstack/react-query'
import { Link, Outlet } from 'react-router-dom'
import { useSession } from '@/modules/session/SessionProvider'
import { useAuth } from '@/modules/auth/AuthProvider'
import { Button, InlineError } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/services/common'
import { toAppError } from '@/lib/errors'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'

export function PlatformShell() {
  const { context } = useSession()
  const { signOut } = useAuth()
  const access = useQuery({ queryKey: ['platform-access', context.user_id], queryFn: async () => unwrap(await supabase.rpc('platform_operator_access'), 'platform.access') })
  if (access.isPending) return <p className="p-6">Checking platform access...</p>
  if (access.isError) return <div className="p-6"><InlineError message={toAppError(access.error).message} /><Button onClick={() => void access.refetch()}>Retry</Button><Link to="/">Return to ERP</Link></div>
  if (!access.data) return <div className="p-6"><p>Platform operator access is required.</p><Link to="/">Return to ERP</Link></div>
  return <div className="min-h-screen bg-slate-50">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b bg-white p-4 sm:px-8">
      <div><p className="font-semibold text-slate-900">Platform Administration</p><p className="text-sm text-slate-500">Organization management</p></div>
      <WorkspaceSwitcher platform />
      <Button variant="secondary" onClick={() => void signOut()}>Sign out</Button>
    </header>
    <div className="mx-auto grid max-w-7xl gap-6 p-4 sm:p-8 lg:grid-cols-[12rem_minmax(0,1fr)]">
      <nav aria-label="Platform navigation"><Link className="block rounded-lg bg-slate-900 px-4 py-3 text-white" to="/platform/tenants">Tenants</Link></nav>
      <main className="min-w-0"><Outlet /></main>
    </div>
  </div>
}
