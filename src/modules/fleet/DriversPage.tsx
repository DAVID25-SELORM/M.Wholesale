import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Button, Card, ConfirmDialog, DataTable, Pagination, PageHeader, SearchInput, StatusBadge, useToast, type Column } from '@/components/ui'
import { useTableState } from '@/hooks/useTableState'
import { toAppError } from '@/lib/errors'
import { useAppSettings } from '@/modules/settings/useAppSettings'
import { useSession } from '@/modules/session/SessionProvider'
import { StatusFilter } from '@/modules/shared/StatusFilter'
import { listDrivers, setDriverActive, type Driver } from '@/services/fleet'
import { DriverForm } from './DriverForm'
import { ExpiryBadge } from './ExpiryBadge'

const PAGE_SIZE = 20
type SortKey = 'name' | 'code' | 'licence_expiry'

export function DriversPage() {
  const { ability, branches } = useSession()
  const { fleetExpiryWarningDays } = useAppSettings()
  const toast = useToast()
  const qc = useQueryClient()
  const { state, setPage, setSearch, setStatus, setSort } = useTableState<SortKey>({ key: 'name', direction: 'asc' })
  const [editing, setEditing] = useState<Driver | 'new' | null>(null)
  const [toggle, setToggle] = useState<Driver | null>(null)

  const params = { page: state.page, pageSize: PAGE_SIZE, search: state.search, status: state.status, sortKey: state.sort.key, sortDirection: state.sort.direction }
  const query = useQuery({ queryKey: ['drivers', params], queryFn: () => listDrivers(params), placeholderData: (prev) => prev })

  const toggleActive = useMutation({
    mutationFn: (d: Driver) => setDriverActive(d.id, !d.is_active),
    onSuccess: async (_d, d) => {
      toast.success(d.is_active ? 'Driver deactivated.' : 'Driver activated.')
      await qc.invalidateQueries({ queryKey: ['drivers'] })
      setToggle(null)
    },
    onError: (e) => { toast.error(toAppError(e).message); setToggle(null) },
  })

  const canCreate = ability.can('fleet.manage')
  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? '—'
  const columns: Column<Driver>[] = [
    { key: 'code', header: 'Code', sortKey: 'code', render: (d) => <span className="font-mono text-xs font-semibold">{d.code}</span> },
    { key: 'name', header: 'Name', sortKey: 'name', render: (d) => <span className="font-medium text-slate-900">{d.name}</span> },
    { key: 'branch', header: 'Branch', hideOnMobile: true, render: (d) => branchName(d.branch_id) },
    { key: 'phone', header: 'Phone', hideOnMobile: true, render: (d) => d.phone ?? '—' },
    { key: 'licence', header: 'Licence', sortKey: 'licence_expiry', render: (d) => <ExpiryBadge date={d.licence_expiry} warningDays={fleetExpiryWarningDays} /> },
    { key: 'status', header: 'Status', render: (d) => <StatusBadge active={d.is_active} /> },
    {
      key: 'actions', header: '', className: 'text-right',
      render: (d) => (
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEditing(d)}>{ability.can('fleet.manage', d.branch_id) ? 'Edit' : 'View'}</Button>
          {ability.can('fleet.manage', d.branch_id) && <Button size="sm" variant="ghost" onClick={() => setToggle(d)}>{d.is_active ? 'Deactivate' : 'Activate'}</Button>}
        </div>
      ),
    },
  ]

  const filtered = state.search || state.status !== 'all'
  return (
    <>
      <PageHeader
        title="Drivers"
        description="The people who deliver. Licence dates are watched so an expired licence cannot be assigned to a delivery run."
        actions={canCreate && <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" aria-hidden /> New driver</Button>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center">
          <div className="flex-1"><SearchInput value={state.search} onChange={setSearch} placeholder="Search by name, code, phone or licence" label="Search drivers" /></div>
          <StatusFilter value={state.status} onChange={setStatus} label="Driver status" />
        </div>
        <DataTable
          caption="Drivers"
          columns={columns}
          rows={query.data?.rows}
          rowKey={(d) => d.id}
          loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null}
          onRetry={() => void query.refetch()}
          sort={state.sort}
          onSortChange={setSort}
          emptyTitle={filtered ? 'No drivers match your filters' : 'No drivers yet'}
          emptyDescription={filtered ? 'Try a different search or status.' : 'Add your first driver to start planning deliveries.'}
        />
        <Pagination page={state.page} pageSize={PAGE_SIZE} total={query.data?.total} onPageChange={setPage} loading={query.isFetching} />
      </Card>
      <DriverForm
        open={editing !== null}
        driver={editing === 'new' ? null : editing}
        canEdit={editing === 'new' ? canCreate : editing ? ability.can('fleet.manage', editing.branch_id) : false}
        onClose={() => setEditing(null)}
      />
      <ConfirmDialog
        open={toggle !== null}
        title={toggle?.is_active ? 'Deactivate driver?' : 'Activate driver?'}
        message={toggle?.is_active ? `“${toggle.name}” can no longer be assigned to new deliveries. History is kept.` : `“${toggle?.name}” can be assigned to deliveries again.`}
        confirmLabel={toggle?.is_active ? 'Deactivate' : 'Activate'}
        tone={toggle?.is_active ? 'danger' : 'primary'}
        loading={toggleActive.isPending}
        onConfirm={() => toggle && toggleActive.mutate(toggle)}
        onCancel={() => setToggle(null)}
      />
    </>
  )
}
