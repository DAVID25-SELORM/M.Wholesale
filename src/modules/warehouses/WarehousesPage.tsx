import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MapPinned, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, ConfirmDialog, DataTable, PageHeader, Pagination, SearchInput, Select, StatusBadge, useToast, type Column } from '@/components/ui'
import { useTableState } from '@/hooks/useTableState'
import { toAppError } from '@/lib/errors'
import { SESSION_QUERY_KEY, ALL_BRANCHES, useSession } from '@/modules/session/SessionProvider'
import { StatusFilter } from '@/modules/shared/StatusFilter'
import { listWarehouses, setWarehouseActive, type Warehouse } from '@/services/warehouses'
import { WAREHOUSE_TYPE_LABEL, WarehouseForm } from './WarehouseForm'

const PAGE_SIZE = 20

export function WarehousesPage() {
  const { ability, branches, selectedBranch } = useSession()
  const toast = useToast()
  const qc = useQueryClient()
  const { state, setPage, setSearch, setStatus, setSort } = useTableState<'name' | 'code' | 'created_at'>({ key: 'name', direction: 'asc' })
  // Filter defaults to the branch chosen in the top bar; the user can widen/narrow it here.
  const [branchOverride, setBranchOverride] = useState<string | null | undefined>(undefined)
  const branchFilter = branchOverride !== undefined ? branchOverride : (selectedBranch === ALL_BRANCHES ? null : selectedBranch)
  const [editing, setEditing] = useState<Warehouse | 'new' | null>(null)
  const [toggle, setToggle] = useState<Warehouse | null>(null)

  const params = { page: state.page, pageSize: PAGE_SIZE, search: state.search, status: state.status, branchId: branchFilter, sortKey: state.sort.key, sortDirection: state.sort.direction }
  const query = useQuery({ queryKey: ['warehouses', params], queryFn: () => listWarehouses(params), placeholderData: (prev) => prev })

  const toggleActive = useMutation({
    mutationFn: (w: Warehouse) => setWarehouseActive(w.id, !w.is_active),
    onSuccess: async (_d, w) => {
      toast.success(w.is_active ? 'Warehouse deactivated.' : 'Warehouse activated.')
      await qc.invalidateQueries({ queryKey: ['warehouses'] })
      await qc.invalidateQueries({ queryKey: SESSION_QUERY_KEY, refetchType: 'none' })
      setToggle(null)
    },
    onError: (e) => { toast.error(toAppError(e).message); setToggle(null) },
  })

  const canCreateAnywhere = ability.canAnywhere('warehouses.create')
  const columns: Column<Warehouse>[] = [
    { key: 'code', header: 'Code', sortKey: 'code', render: (w) => <span className="font-mono text-xs font-semibold">{w.code}</span> },
    { key: 'name', header: 'Name', sortKey: 'name', render: (w) => <span className="font-medium text-slate-900">{w.name}</span> },
    { key: 'branch', header: 'Branch', render: (w) => w.branch?.name ?? '—' },
    { key: 'type', header: 'Type', hideOnMobile: true, render: (w) => <Badge>{WAREHOUSE_TYPE_LABEL[w.warehouse_type]}</Badge> },
    { key: 'status', header: 'Status', render: (w) => <StatusBadge active={w.is_active} /> },
    {
      key: 'actions', header: '', className: 'text-right',
      render: (w) => (
        <div className="flex justify-end gap-1">
          {ability.canAnywhere('warehouse_locations.view') && (
            <Link to={`/admin/locations?warehouse=${w.id}`} className="inline-flex h-8 items-center gap-1 rounded-md px-3 text-sm text-slate-600 hover:bg-slate-100">
              <MapPinned className="h-4 w-4" aria-hidden /> Locations
            </Link>
          )}
          <Button size="sm" variant="ghost" onClick={() => setEditing(w)}>{ability.can('warehouses.edit', w.branch_id) ? 'Edit' : 'View'}</Button>
          {ability.can('warehouses.edit', w.branch_id) && (
            <Button size="sm" variant="ghost" onClick={() => setToggle(w)}>{w.is_active ? 'Deactivate' : 'Activate'}</Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        title="Warehouses"
        description="Stock-holding sites within your branches."
        actions={canCreateAnywhere && <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" aria-hidden /> New warehouse</Button>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center">
          <div className="flex-1"><SearchInput value={state.search} onChange={setSearch} placeholder="Search by name or code" label="Search warehouses" /></div>
          <div className="w-full lg:w-56">
            <label htmlFor="wh-branch" className="sr-only">Filter by branch</label>
            <Select id="wh-branch" value={branchFilter ?? ''} onChange={(e) => { setBranchOverride(e.target.value || null); setPage(0) }}>
              {ability.hasOrgWideAccess && <option value="">All branches</option>}
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </div>
          <StatusFilter value={state.status} onChange={setStatus} label="Warehouse status" />
        </div>
        <DataTable
          caption="Warehouses"
          columns={columns}
          rows={query.data?.rows}
          rowKey={(w) => w.id}
          loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null}
          onRetry={() => void query.refetch()}
          sort={state.sort}
          onSortChange={setSort}
          emptyTitle="No warehouses found"
          emptyDescription={state.search || state.status !== 'all' || branchFilter ? 'Try changing the filters.' : 'Create the first warehouse to get started.'}
        />
        <Pagination page={state.page} pageSize={PAGE_SIZE} total={query.data?.total} onPageChange={setPage} loading={query.isFetching} />
      </Card>

      <WarehouseForm
        open={editing !== null}
        warehouse={editing === 'new' ? null : editing}
        canEdit={editing === 'new' ? canCreateAnywhere : editing ? ability.can('warehouses.edit', editing.branch_id) : false}
        defaultBranchId={branchFilter}
        onClose={() => setEditing(null)}
      />
      <ConfirmDialog
        open={toggle !== null}
        title={toggle?.is_active ? 'Deactivate warehouse?' : 'Activate warehouse?'}
        message={toggle?.is_active ? `“${toggle.name}” will be marked inactive. Its history is kept.` : `“${toggle?.name}” will become active again.`}
        confirmLabel={toggle?.is_active ? 'Deactivate' : 'Activate'}
        tone={toggle?.is_active ? 'danger' : 'primary'}
        loading={toggleActive.isPending}
        onConfirm={() => toggle && toggleActive.mutate(toggle)}
        onCancel={() => setToggle(null)}
      />
    </>
  )
}
