import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { cn, useDebouncedValue } from '@/lib/utils'
import { Button } from './button'
import { EmptyState, ErrorState, LoadingState } from './states'

export interface Column<T> {
  key: string
  header: string
  render: (row: T) => ReactNode
  /** column id sent to the server as sort key; omit when not sortable */
  sortKey?: string
  className?: string
  /** hide below the md breakpoint to keep phones readable */
  hideOnMobile?: boolean
}

export interface SortState { key: string; direction: 'asc' | 'desc' }

interface DataTableProps<T> {
  columns: Column<T>[]
  rows: T[] | undefined
  rowKey: (row: T) => string
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  emptyTitle?: string
  emptyDescription?: string
  emptyAction?: ReactNode
  sort?: SortState | undefined
  onSortChange?: (s: SortState) => void
  caption?: string
}

/** Presentational table: controlled sorting, loading / error / empty states. Data is fetched server-side. */
export function DataTable<T>({
  columns, rows, rowKey, loading, error, onRetry, emptyTitle = 'Nothing here yet', emptyDescription, emptyAction, sort, onSortChange, caption,
}: DataTableProps<T>) {
  if (error) return <ErrorState message={error} {...(onRetry ? { onRetry } : {})} />
  if (loading && !rows) return <LoadingState />
  if (rows && rows.length === 0) {
    return <EmptyState title={emptyTitle} {...(emptyDescription ? { description: emptyDescription } : {})} {...(emptyAction ? { action: emptyAction } : {})} />
  }
  return (
    <div className={cn('overflow-x-auto', loading && 'opacity-60 transition-opacity')} aria-busy={loading || undefined}>
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="bg-slate-50">
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.sortKey
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={active ? (sort?.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={cn('whitespace-nowrap px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500', c.hideOnMobile && 'hidden md:table-cell', c.className)}
                >
                  {c.sortKey && onSortChange ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-slate-800"
                      onClick={() => onSortChange({ key: c.sortKey!, direction: active && sort?.direction === 'asc' ? 'desc' : 'asc' })}
                    >
                      {c.header}
                      {active && (sort?.direction === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
                    </button>
                  ) : c.header}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {(rows ?? []).map((row) => (
            <tr key={rowKey(row)} className="hover:bg-slate-50">
              {columns.map((c) => (
                <td key={c.key} className={cn('px-4 py-2.5 align-middle text-slate-700', c.hideOnMobile && 'hidden md:table-cell', c.className)}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface PaginationProps {
  page: number // zero based
  pageSize: number
  /** exact total when known */
  total?: number | undefined
  /** used when total is unknown (e.g. audit log): whether another page exists */
  hasNext?: boolean | undefined
  onPageChange: (page: number) => void
  loading?: boolean | undefined
}

export function Pagination({ page, pageSize, total, hasNext, onPageChange, loading }: PaginationProps) {
  const from = page * pageSize + 1
  const lastKnown = total !== undefined ? Math.min((page + 1) * pageSize, total) : undefined
  const next = total !== undefined ? (page + 1) * pageSize < total : Boolean(hasNext)
  if (total === 0) return null
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-3 text-sm text-slate-500">
      <span>
        {total !== undefined ? `${from}–${lastKnown} of ${total}` : `Page ${page + 1}`}
      </span>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={page === 0 || loading} onClick={() => onPageChange(page - 1)} aria-label="Previous page">
          <ChevronLeft className="h-4 w-4" /> Prev
        </Button>
        <Button variant="secondary" size="sm" disabled={!next || loading} onClick={() => onPageChange(page + 1)} aria-label="Next page">
          Next <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </nav>
  )
}

export function SearchInput({ value, onChange, placeholder = 'Search…', label = 'Search', delayMs = 300 }: {
  value: string; onChange: (v: string) => void; placeholder?: string; label?: string; delayMs?: number
}) {
  const [local, setLocal] = useState(value)
  // follow external resets (e.g. "clear filters") without an effect: adjust state while rendering
  const [seenValue, setSeenValue] = useState(value)
  if (value !== seenValue) { setSeenValue(value); setLocal(value) }
  const debounced = useDebouncedValue(local, delayMs)
  useEffect(() => { if (debounced !== value) onChange(debounced) }, [debounced]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
      <input
        type="search"
        aria-label={label}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        placeholder={placeholder}
        className="block h-10 w-full rounded-md border-0 bg-white pl-9 pr-3 text-sm text-slate-900 shadow-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
    </div>
  )
}
