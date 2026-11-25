import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useEffect, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import { cleanTerm, globalSearch, type SearchHit } from '@/services/search'

export function GlobalSearch() {
  const { ability, context } = useSession()
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [term, setTerm] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  useEffect(() => { const t = setTimeout(() => setTerm(cleanTerm(text)), 250); return () => clearTimeout(t) }, [text])
  const query = useQuery({
    queryKey: ['global-search', context.user_id, term],
    enabled: term.length >= 2,
    staleTime: 30_000,
    queryFn: () => globalSearch(term, (p) => ability.canAnyOf([p])),
  })
  const hits = term.length >= 2 ? (query.data ?? []) : []
  const showing = open && term.length >= 2
  const go = (hit: SearchHit) => { setOpen(false); setText(''); setTerm(''); void navigate(hit.to) }
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') { setOpen(false); return }
    if (!showing || hits.length === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % hits.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + hits.length) % hits.length) }
    else if (e.key === 'Enter') { e.preventDefault(); const hit = hits[active]; if (hit) go(hit) }
  }
  return (
    <div className="relative ml-auto hidden max-w-sm flex-1 md:block" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false) }}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
      <input
        type="search" role="combobox" aria-label="Global search" aria-expanded={showing} aria-controls="global-search-results" aria-autocomplete="list"
        aria-activedescendant={showing && hits[active] ? `search-hit-${active}` : undefined}
        value={text} placeholder="Search products, customers, orders…" maxLength={60}
        onChange={(e) => { setText(e.target.value); setOpen(true); setActive(0) }} onFocus={() => setOpen(true)} onKeyDown={onKeyDown}
        className="h-9 w-full rounded-md border-0 bg-slate-50 pl-9 pr-3 text-sm text-slate-800 ring-1 ring-inset ring-slate-200 focus:bg-white focus:ring-2 focus:ring-brand-500"
      />
      {showing && (
        <div className="absolute left-0 right-0 top-11 z-40 max-h-96 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg">
          {query.isError && <p role="alert" className="px-3 py-2 text-sm text-red-700">{toAppError(query.error).message}</p>}
          {query.isFetching && hits.length === 0 && <p className="px-3 py-2 text-sm text-slate-500">Searching…</p>}
          {query.isSuccess && !query.isFetching && hits.length === 0 && <p className="px-3 py-2 text-sm text-slate-500">No matches.</p>}
          <ul id="global-search-results" role="listbox" aria-label="Search results">
            {hits.map((hit, i) => (
              <li key={`${hit.section}-${hit.id}`} role="presentation">
                {hits[i - 1]?.section !== hit.section && <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{hit.section}</p>}
                <button type="button" role="option" id={`search-hit-${i}`} aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => go(hit)}
                  className={`flex w-full justify-between gap-3 px-3 py-2 text-left text-sm ${i === active ? 'bg-brand-50' : ''}`}>
                  <span className="truncate font-medium text-slate-800">{hit.title}</span><span className="shrink-0 text-xs text-slate-500">{hit.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
