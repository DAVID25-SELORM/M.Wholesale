import { useQuery } from '@tanstack/react-query'
import { Link, NavLink, Outlet, Navigate } from 'react-router-dom'
import { useState } from 'react'
import { useAuth } from '@/modules/auth/AuthProvider'
import { Button, InlineError } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/services/common'
import { toAppError } from '@/lib/errors'
import { readPlatform } from '@/modules/platform/api'

export function PlatformShell() {
  const { auth, signOut } = useAuth()
  const [menu, setMenu] = useState(false)
  const [dark, setDark] = useState(() => { try { return localStorage.getItem('platform.theme') === 'dark' } catch { return false } })
  const access = useQuery({ queryKey: ['platform-access', auth.session?.user.id], enabled: auth.status === 'signedIn', queryFn: async () => unwrap(await supabase.rpc('platform_operator_access'), 'platform.access') })
  const permissions = useQuery({ queryKey: ['platform', 'access', auth.session?.user.id], enabled: !!access.data, queryFn: () => readPlatform('access') })
  if (auth.status === 'signedOut') return <Navigate to="/login" replace state={{ from: '/platform' }} />
  if (access.isPending) return <p className="p-6">Checking platform access...</p>
  if (access.isError) return <div className="p-6"><InlineError message={toAppError(access.error).message} /><Button onClick={() => void access.refetch()}>Retry</Button><Link to="/">Return to ERP</Link></div>
  if (!access.data) return <div className="p-6"><p>Platform operator access is required.</p><Link to="/">Return to ERP</Link></div>
  return <div data-platform-theme={dark ? 'dark' : 'light'} className="min-h-screen bg-slate-50">
    <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-4 border-b bg-white p-4 sm:px-8">
      <Button className="lg:hidden" variant="secondary" aria-expanded={menu} onClick={() => setMenu(!menu)}>Menu</Button>
      <div><p className="font-semibold text-slate-900">Platform Administration</p><p className="text-sm text-slate-500">{String(permissions.data?.platform_name ?? 'Pharmacy Wholesale ERP')}</p></div>
      <Link to="/" className="text-sm text-emerald-700 underline">Switch to organization ERP</Link>
      <Button variant="secondary" aria-pressed={dark} onClick={() => { setDark(!dark); try { localStorage.setItem('platform.theme', dark ? 'light' : 'dark') } catch { /* Optional local preference. */ } }}>{dark ? 'Light mode' : 'Dark mode'}</Button>
      <Button variant="secondary" onClick={() => void signOut()}>Sign out</Button>
    </header>
    <div className="mx-auto grid max-w-[1600px] gap-6 p-4 sm:p-8 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <nav aria-label="Platform navigation" className={`${menu ? 'block' : 'hidden'} space-y-1 rounded-xl bg-slate-900 p-3 text-slate-200 lg:block`}>
        {[
          ['overview', 'Dashboard', 'overview'], ['organizations', 'Organizations', 'organizations'], ['create', 'Create organization', 'organizations'],
          ['users', 'Users', 'users'], ['operators', 'Administrators', 'operators'], ['plans', 'Subscription plans', 'billing'], ['subscriptions', 'Subscriptions', 'billing'], ['invoices', 'Invoices', 'billing'], ['payments', 'Payments', 'billing'],
          ['audit', 'Activity & audit', 'audit'], ['notifications', 'Notifications', 'audit'], ['tickets', 'Support tickets', 'support'], ['announcements', 'Announcements', 'support'], ['settings', 'General settings', 'settings'],
        ].filter(([, , permission]) => (permissions.data?.permissions as string[] | undefined)?.includes(permission!)).map(([path, label]) => <NavLink key={path} onClick={() => setMenu(false)} to={`/platform/${path}`} className={({ isActive }) => `block rounded-lg px-3 py-2.5 text-sm ${isActive ? 'bg-emerald-700 text-white' : 'hover:bg-slate-800'}`}>{label}</NavLink>)}
      </nav>
      <main className="min-w-0"><InlineError message={permissions.isError ? permissions.error.message : null} /><Outlet /></main>
    </div>
  </div>
}
