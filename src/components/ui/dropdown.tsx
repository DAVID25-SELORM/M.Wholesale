import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface DropdownItem {
  id: string
  label: ReactNode
  onSelect: () => void
  disabled?: boolean
  danger?: boolean
}

/** Button + menu. Closes on outside click / Escape; items are real buttons (keyboard friendly). */
export function Dropdown({ trigger, items, align = 'right', label }: {
  trigger: ReactNode; items: DropdownItem[]; align?: 'left' | 'right'; label: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        {trigger}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          className={cn('absolute z-40 mt-2 min-w-48 rounded-md border border-slate-200 bg-white py-1 shadow-lg', align === 'right' ? 'right-0' : 'left-0')}
        >
          {items.map((it) => (
            <button
              key={it.id}
              role="menuitem"
              type="button"
              disabled={it.disabled}
              onClick={() => { setOpen(false); it.onSelect() }}
              className={cn('block w-full px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:text-slate-300', it.danger ? 'text-red-600' : 'text-slate-700')}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
