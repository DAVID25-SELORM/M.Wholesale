import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button, Card, ConfirmDialog, DataTable, EmptyState, PageHeader, Pagination, SearchInput, Select, StatusBadge, useToast, type Column } from '@/components/ui'
import { useTableState } from '@/hooks/useTableState'
import { toAppError } from '@/lib/errors'
import { ALL_BRANCHES, useSession } from '@/modules/session/SessionProvider'
import { StatusFilter } from '@/modules/shared/StatusFilter'
import { listLocations, listWarehouseOptions, setLocationActive, type WarehouseLocation } from '@/services/warehouses'
import { LocationForm } from './LocationForm'

const PAGE_SIZE = 25

export function LocationsPage() {
  const { ability, selectedBranch } = useSession()
  const toast = useToast()
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const warehouseId = params.get('warehouse') ?? ''
  const { state, setPage, setSearch, setStatus, setSort } = useTableState<'picking_sequence' | 'code'>({ key: 'picking_sequence', direction: 'asc' })
  const [editing, setEditing] = useState<WarehouseLocation | 'new' | null>(null)
  const [toggle, setToggle] = useState<WarehouseLocation | null>(null)

  const branchScope = selectedBranch === ALL_BRANCHES ? null : selectedBranch
  const whQuery = useQuery({ queryKey: ['warehouses', 'options', branchScope], queryFn: () => listWarehouseOptions(branchScope), staleTime: 60_000 })
  const warehouses = whQuery.data ?? []
  const selectedWarehouse = warehouses.find((w) => w.id === warehouseId) ?? null

  // Pick the first warehouse automatically; drop a stale selection after a branch switch.
  useEffect(() => {
    if (!whQuery.data) return
    if (!whQuery.data.some((w) => w.id === warehouseId)) {
      const next = new URLSearchParams(params)
      if (whQuery.data[0]) next.set('warehouse', whQuery.data[0].id); else next.delete('warehouse')
      setParams(next, { replace: true })
    }
  }, [whQuery.data]) // eslint-disable-line react-hooks/exhaustive-deps

  const listParams = { warehouseId, page: state.page, pageSize: PAGE_SIZE, search: state.search, status: state.status, sortKey: state.sort.key, sortDirection: state.sort.direction }
  const query = useQuery({
    queryKey: ['locations', listParams],
    queryFn: () => listLocations(listParams),
    enabled: Boolean(selectedWarehouse),
    placeholderData: (prev) => prev,
  })

  const toggleActive = useMutation({
    mutationFn: (l: WarehouseLocation) => setLocationActive(l.id, !l.is_active),
    onSuccess: async (_d, l) => {
      toast.success(l.is_active ? 'Location deactivated.' : 'Location activated.')
      await qc.invalidateQueries({ queryKey: ['locations'] })
      setToggle(null)
    },
    onError: (e) => { toast.error(toAppError(e).message); setToggle(null) },
  })

  const branchId = selectedWarehouse?.branch_id ?? null
  const canCreate = ability.can('warehouse_locations.create', branchId)
  const canEditRow = ability.can('warehouse_locations.edit', branchId)

  const columns: Column<WarehouseLocation>[] = [
    { key: 'seq', header: 'Pick order', sortKey: 'picking_sequence', render: (l) => <span className="tabular-nums">{l.picking_sequence}</span> },
    { key: 'code', header: 'Code', sortKey: 'code', render: (l) => <span className="font-mono text-xs font-semibold">{l.code}</span> },
    { key: 'aisle', header: 'Aisle', hideOnMobile: true, render: (l) => l.aisle ?? '—' },
    { key: 'rack', header: 'Rack', hideOnMobile: true, render: (l) => l.rack ?? '—' },
    { key: 'shelf', header: 'Shelf', hideOnMobile: true, render: (l) => l.shelf ?? '—' },
    { key: 'bin', header: 'Bin', hideOnMobile: true, render: (l) => l.bin ?? '—' },
    { key: 'status', header: 'Status', render: (l) => <StatusBadge active={l.is_active} /> },
    {
      key: 'actions', header: '', className: 'text-right',
      render: (l) => (
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEditing(l)}>{canEditRow ? 'Edit' : 'View'}</Button>
          {canEditRow && <Button size="sm" variant="ghost" onClick={() => setToggle(l)}>{l.is_active ? 'Deactivate' : 'Activate'}</Button>}
        </div>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        title="Warehouse locations"
        description="Aisle → rack → shelf → bin. The pick order decides the walking sequence on future pick lists."
        actions={canCreate && selectedWarehouse && <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" aria-hidden /> New location</Button>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center">
          <div className="w-full lg:w-72">
            <label htmlFor="loc-warehouse" className="sr-only">Warehouse</label>
            <Select id="loc-warehouse" value={warehouseId} onChange={(e) => { setParams({ warehouse: e.target.value }); setPage(0) }} disabled={warehouses.length === 0}>
              {warehouses.length === 0 && <option value="">No warehouses</option>}
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
            </Select>
          </div>
          <div className="flex-1"><SearchInput value={state.search} onChange={setSearch} placeholder="Search code, aisle, rack, shelf or bin" label="Search locations" /></div>
          <StatusFilter value={state.status} onChange={setStatus} label="Location status" />
        </div>
        {whQuery.isSuccess && warehouses.length === 0 ? (
          <EmptyState title="No warehouses available" description="Create a warehouse first, then add locations to it." />
        ) : (
          <>
            <DataTable
              caption="Warehouse locations"
              columns={columns}
              rows={query.data?.rows}
              rowKey={(l) => l.id}
              loading={query.isFetching || whQuery.isPending}
              error={query.isError ? toAppError(query.error).message : null}
              onRetry={() => void query.refetch()}
              sort={state.sort}
              onSortChange={setSort}
              emptyTitle="No locations yet"
              emptyDescription={state.search || state.status !== 'all' ? 'Try changing the filters.' : 'Add the first aisle / rack / shelf / bin.'}
            />
            <Pagination page={state.page} pageSize={PAGE_SIZE} total={query.data?.total} onPageChange={setPage} loading={query.isFetching} />
          </>
        )}
      </Card>

      {selectedWarehouse && (
        <LocationForm
          open={editing !== null}
          location={editing === 'new' ? null : editing}
          warehouseId={selectedWarehouse.id}
          canEdit={editing === 'new' ? canCreate : canEditRow}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={toggle !== null}
        title={toggle?.is_active ? 'Deactivate location?' : 'Activate location?'}
        message={toggle?.is_active ? `Location ${toggle.code} will be marked inactive. Its history is kept.` : `Location ${toggle?.code} will become active again.`}
        confirmLabel={toggle?.is_active ? 'Deactivate' : 'Activate'}
        tone={toggle?.is_active ? 'danger' : 'primary'}
        loading={toggleActive.isPending}
        onConfirm={() => toggle && toggleActive.mutate(toggle)}
        onCancel={() => setToggle(null)}
      />
    </>
  )
}
