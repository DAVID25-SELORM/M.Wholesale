import { useCallback, useState } from 'react'
import type { SortState } from '@/components/ui'

export interface TableState<K extends string> {
  page: number
  search: string
  status: 'all' | 'active' | 'inactive'
  sort: SortState & { key: K }
}

/** Page / search / status / sort state for admin tables. Any filter change returns to page 0. */
export function useTableState<K extends string>(initialSort: SortState & { key: K }, initialStatus: TableState<K>['status'] = 'all') {
  const [state, setState] = useState<TableState<K>>({ page: 0, search: '', status: initialStatus, sort: initialSort })

  const setPage = useCallback((page: number) => setState((s) => ({ ...s, page })), [])
  const setSearch = useCallback((search: string) => setState((s) => ({ ...s, search, page: 0 })), [])
  const setStatus = useCallback((status: TableState<K>['status']) => setState((s) => ({ ...s, status, page: 0 })), [])
  const setSort = useCallback((sort: SortState) => setState((s) => ({ ...s, sort: sort as SortState & { key: K }, page: 0 })), [])

  return { state, setPage, setSearch, setStatus, setSort }
}
