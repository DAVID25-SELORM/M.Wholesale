import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { NAV_GROUPS, NAV_TOP, type NavGroup, type NavItem } from '@/config/navigation'
import { cn } from '@/lib/utils'
import { useSession } from '@/modules/session/SessionProvider'

const linkBase = 'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400'

function Item({ item, onNavigate }: { item: NavItem; onNavigate: () => void }) {
  if (item.planned || !item.to) {
    return (
      <li>
        <span aria-disabled="true" className={cn(linkBase, 'cursor-not-allowed text-slate-500')}>
          <span className="flex-1 truncate">{item.label}</span>
          <span className="rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">Soon</span>
        </span>
      </li>
    )
  }
  return (
    <li>
      <NavLink
        to={item.to}
        end={item.to === '/'}
        onClick={onNavigate}
        className={({ isActive }) => cn(linkBase, isActive ? 'bg-brand-600/20 font-medium text-white' : 'text-slate-300 hover:bg-slate-700/50 hover:text-white')}
      >
        {item.label}
      </NavLink>
    </li>
  )
}

function Group({ group, visibleItems, onNavigate }: { group: NavGroup; visibleItems: NavItem[]; onNavigate: () => void }) {
  const [open, setOpen] = useState(!group.collapsedByDefault)
  const Icon = group.icon
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      >
        <Icon className="h-4 w-4" aria-hidden />
        <span className="flex-1 text-left">{group.label}</span>
        <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && <ul className="mt-0.5 space-y-0.5 pl-2">{visibleItems.map((i) => <Item key={i.id} item={i} onNavigate={onNavigate} />)}</ul>}
    </div>
  )
}

export function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const { ability, context } = useSession()
  const TopIcon = NAV_TOP.icon

  const groups = NAV_GROUPS.map((g) => ({
    group: g,
    visibleItems: g.items.filter((i) => i.planned || !i.anyOf || ability.canAnyOf(i.anyOf)),
  })).filter((g) => g.visibleItems.length > 0)

  return (
    <nav aria-label="Main navigation" className="flex h-full flex-col bg-slate-900">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-800 px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">Rx</div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">{context.organization?.name}</p>
          <p className="truncate text-[11px] text-slate-400">Wholesale ERP</p>
        </div>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto px-2 py-3">
        <NavLink
          to={NAV_TOP.to ?? '/'}
          end
          onClick={onNavigate}
          className={({ isActive }) => cn(linkBase, isActive ? 'bg-brand-600/20 font-medium text-white' : 'text-slate-300 hover:bg-slate-700/50 hover:text-white')}
        >
          {TopIcon && <TopIcon className="h-4 w-4" aria-hidden />}
          {NAV_TOP.label}
        </NavLink>
        {groups.map(({ group, visibleItems }) => (
          <Group key={group.id} group={group} visibleItems={visibleItems} onNavigate={onNavigate} />
        ))}
      </div>
    </nav>
  )
}
