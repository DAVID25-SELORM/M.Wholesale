import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface TabItem { id: string; label: string; badge?: ReactNode }

export function Tabs({ items, value, onChange, label }: { items: TabItem[]; value: string; onChange: (id: string) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-slate-200">
      {items.map((t) => {
        const selected = t.id === value
        return (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={selected}
            onClick={() => onChange(t.id)}
            className={cn(
              'whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
              selected ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700',
            )}
          >
            {t.label}
            {t.badge !== undefined && <span className="ml-1.5 text-xs text-slate-400">{t.badge}</span>}
          </button>
        )
      })}
    </div>
  )
}
