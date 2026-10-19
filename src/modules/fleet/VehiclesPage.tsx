import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Card, ConfirmDialog, DataTable, Pagination, PageHeader, SearchInput, StatusBadge, useToast, type Column } from '@/components/ui'
import { useTableState } from '@/hooks/useTableState'
import { toAppError } from '@/lib/errors'
import { useAppSettings } from '@/modules/settings/useAppSettings'
import { useSession } from '@/modules/session/SessionProvider'
import { StatusFilter } from '@/modules/shared/StatusFilter'
import { listVehicles, setVehicleActive, type Vehicle } from '@/services/fleet'
import { ExpiryBadge } from './ExpiryBadge'
import { VehicleForm } from './VehicleForm'

const PAGE_SIZE = 20
type SortKey = 'registration_number' | 'insurance_expiry' | 'roadworthy_expiry'

export function VehiclesPage() {
  const { ability, branches } = useSession()
  const { fleetExpiryWarningDays } = useAppSettings()
  const toast = useToast()
  const qc = useQueryClient()
  const { state, setPage, setSearch, setStatus, setSort } = useTableState<SortKey>({ key: 'registration_number', direction: 'asc' })
  const [editing, setEditing] = useState<Vehicle | 'new' | null>(null)
  const [toggle, setToggle] = useState<Vehicle | null>(null)

  const params = { page: state.page, pageSize: PAGE_SIZE, search: state.search, status: state.status, sortKey: state.sort.key, sortDirection: state.sort.direction }
  const query = useQuery({ queryKey: ['vehicles', params], queryFn: () => listVehicles(params), placeholderData: (prev) => prev })

  const toggleActive = useMutation({
    mutationFn: (v: Vehicle) => setVehicleActive(v.id, !v.is_active),
    onSuccess: async (_d, v) => {
      toast.success(v.is_active ? 'Vehicle deactivated.' : 'Vehicle activated.')
      await qc.invalidateQueries({ queryKey: ['vehicles'] })
      setToggle(null)
    },
    onError: (e) => { toast.error(toAppError(e).message); setToggle(null) },
  })

  const canCreate = ability.can('fleet.manage')
  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? '—'
  const columns: Column<Vehicle>[] = [
    {
      key: 'reg', header: 'Registration', sortKey: 'registration_number',
      render: (v) => (
        <span className="font-medium text-slate-900">
          <span className="font-mono text-xs font-semibold">{v.registration_number}</span>
          {v.refrigerated && <Badge tone="blue" className="ml-2">Refrigerated</Badge>}
        </span>
      ),
    },
    { key: 'type', header: 'Type', hideOnMobile: true, render: (v) => v.vehicle_type.charAt(0) + v.vehicle_type.slice(1).toLowerCase() },
    { key: 'branch', header: 'Branch', hideOnMobile: true, render: (v) => branchName(v.branch_id) },
    { key: 'insurance', header: 'Insurance', sortKey: 'insurance_expiry', render: (v) => <ExpiryBadge date={v.insurance_expiry} warningDays={fleetExpiryWarningDays} /> },
    { key: 'roadworthy', header: 'Roadworthy', sortKey: 'roadworthy_expiry', hideOnMobile: true, render: (v) => <ExpiryBadge date={v.roadworthy_expiry} warningDays={fleetExpiryWarningDays} /> },
    { key: 'status', header: 'Status', render: (v) => <StatusBadge active={v.is_active} /> },
    {
      key: 'actions', header: '', className: 'text-right',
      render: (v) => (
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEditing(v)}>{ability.can('fleet.manage', v.branch_id) ? 'Edit' : 'View'}</Button>
          {ability.can('fleet.manage', v.branch_id) && <Button size="sm" variant="ghost" onClick={() => setToggle(v)}>{v.is_active ? 'Deactivate' : 'Activate'}</Button>}
        </div>
      ),
    },
  ]

  const filtered = state.search || state.status !== 'all'
  return (
    <>
      <PageHeader
        title="Vehicles"
        description="Delivery vehicles with insurance and roadworthy dates. An expired vehicle cannot be assigned to a delivery run."
        actions={canCreate && <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" aria-hidden /> New vehicle</Button>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center">
          <div className="flex-1"><SearchInput value={state.search} onChange={setSearch} placeholder="Search by registration or name" label="Search vehicles" /></div>
          <StatusFilter value={state.status} onChange={setStatus} label="Vehicle status" />
        </div>
        <DataTable
          caption="Vehicles"
          columns={columns}
          rows={query.data?.rows}
          rowKey={(v) => v.id}
          loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null}
          onRetry={() => void query.refetch()}
          sort={state.sort}
          onSortChange={setSort}
          emptyTitle={filtered ? 'No vehicles match your filters' : 'No vehicles yet'}
          emptyDescription={filtered ? 'Try a different search or status.' : 'Add your first vehicle to start planning deliveries.'}
        />
        <Pagination page={state.page} pageSize={PAGE_SIZE} total={query.data?.total} onPageChange={setPage} loading={query.isFetching} />
      </Card>
      <VehicleForm
        open={editing !== null}
        vehicle={editing === 'new' ? null : editing}
        canEdit={editing === 'new' ? canCreate : editing ? ability.can('fleet.manage', editing.branch_id) : false}
        onClose={() => setEditing(null)}
      />
      <ConfirmDialog
        open={toggle !== null}
        title={toggle?.is_active ? 'Deactivate vehicle?' : 'Activate vehicle?'}
        message={toggle?.is_active ? `${toggle.registration_number} can no longer be assigned to new deliveries. History is kept.` : `${toggle?.registration_number} can be assigned to deliveries again.`}
        confirmLabel={toggle?.is_active ? 'Deactivate' : 'Activate'}
        tone={toggle?.is_active ? 'danger' : 'primary'}
        loading={toggleActive.isPending}
        onConfirm={() => toggle && toggleActive.mutate(toggle)}
        onCancel={() => setToggle(null)}
      />
    </>
  )
}
