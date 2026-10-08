import { Bell, Building2, LogOut, Menu, Search, UserCircle2 } from 'lucide-react'
import { Dropdown } from '@/components/ui'
import { useAuth } from '@/modules/auth/AuthProvider'
import { ALL_BRANCHES, useSession } from '@/modules/session/SessionProvider'

export function BranchSelector() {
  const { branches, selectedBranch, selectBranch, ability } = useSession()
  const options = branches.filter((b) => b.is_active)
  if (options.length === 0) return null
  // A single-branch user has nothing to choose.
  const locked = options.length === 1 && !ability.hasOrgWideAccess
  return (
    <div className="flex items-center gap-2">
      <Building2 className="hidden h-4 w-4 text-slate-400 sm:block" aria-hidden />
      <label htmlFor="branch-selector" className="sr-only">Branch</label>
      <select
        id="branch-selector"
        value={selectedBranch}
        disabled={locked}
        onChange={(e) => selectBranch(e.target.value)}
        className="h-9 max-w-[11rem] truncate rounded-md border-0 bg-white py-1 pl-2 pr-7 text-sm text-slate-700 shadow-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-500 disabled:bg-slate-50 sm:max-w-[16rem]"
      >
        {ability.hasOrgWideAccess && <option value={ALL_BRANCHES}>All branches</option>}
        {options.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
    </div>
  )
}

export function Topbar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { context } = useSession()
  const { signOut } = useAuth()
  const name = context.profile?.display_name ?? `${context.profile?.first_name ?? ''} ${context.profile?.last_name ?? ''}`.trim()
  const roleNames = (context.roles ?? []).map((r) => r.role_name)

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 sm:gap-3 sm:px-4">
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label="Open navigation menu"
        className="rounded-md p-2 text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      <BranchSelector />

      {/* Global search is a placeholder until product/customer modules exist. */}
      <div className="relative ml-auto hidden max-w-sm flex-1 md:block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <input
          type="search"
          disabled
          aria-label="Global search (coming soon)"
          placeholder="Search products, customers, orders… (coming soon)"
          className="h-9 w-full cursor-not-allowed rounded-md border-0 bg-slate-50 pl-9 pr-3 text-sm text-slate-400 ring-1 ring-inset ring-slate-200"
        />
      </div>

      <div className="ml-auto flex items-center gap-1 md:ml-0">
        <button
          type="button"
          disabled
          aria-label="Notifications (none yet)"
          className="rounded-md p-2 text-slate-400 disabled:cursor-not-allowed"
        >
          <Bell className="h-5 w-5" />
        </button>
        <Dropdown
          label="User menu"
          trigger={
            <span className="flex items-center gap-2 rounded-md p-1.5 hover:bg-slate-100">
              <UserCircle2 className="h-6 w-6 text-slate-500" aria-hidden />
              <span className="hidden max-w-[10rem] truncate text-sm font-medium text-slate-700 sm:block">{name}</span>
            </span>
          }
          items={[
            { id: 'who', label: <span className="block"><span className="block text-sm font-medium text-slate-800">{name}</span><span className="block text-xs text-slate-500">{roleNames.join(', ') || 'No roles'}</span></span>, onSelect: () => {}, disabled: true },
            { id: 'signout', label: <span className="flex items-center gap-2"><LogOut className="h-4 w-4" aria-hidden /> Sign out</span>, onSelect: () => void signOut() },
          ]}
        />
      </div>
    </header>
  )
}
