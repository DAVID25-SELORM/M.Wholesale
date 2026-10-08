import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Card, ConfirmDialog, DataTable, Pagination, PageHeader, SearchInput, StatusBadge, useToast, type Column } from '@/components/ui'
import { useTableState } from '@/hooks/useTableState'
import { toAppError } from '@/lib/errors'
import { StatusFilter } from '@/modules/shared/StatusFilter'
import { SESSION_QUERY_KEY, useSession } from '@/modules/session/SessionProvider'
import { listBranches, setBranchActive, type Branch } from '@/services/branches'
import { BranchForm } from './BranchForm'

const PAGE_SIZE = 20

export function BranchesPage() {
  const { ability } = useSession()
  const toast = useToast()
  const qc = useQueryClient()
  const { state, setPage, setSearch, setStatus, setSort } = useTableState<'name' | 'code' | 'created_at'>({ key: 'name', direction: 'asc' })
  const [editing, setEditing] = useState<Branch | 'new' | null>(null)
  const [toggle, setToggle] = useState<Branch | null>(null)

  const params = { page: state.page, pageSize: PAGE_SIZE, search: state.search, status: state.status, sortKey: state.sort.key, sortDirection: state.sort.direction }
  const query = useQuery({ queryKey: ['branches', params], queryFn: () => listBranches(params), placeholderData: (prev) => prev })

  const toggleActive = useMutation({
    mutationFn: (b: Branch) => setBranchActive(b.id, !b.is_active),
    onSuccess: async (_d, b) => {
      toast.success(b.is_active ? 'Branch deactivated.' : 'Branch activated.')
      await Promise.all([qc.invalidateQueries({ queryKey: ['branches'] }), qc.invalidateQueries({ queryKey: SESSION_QUERY_KEY })])
      setToggle(null)
    },
    onError: (e) => { toast.error(toAppError(e).message); setToggle(null) },
  })

  const canCreate = ability.can('branches.create')
  const columns: Column<Branch>[] = [
    { key: 'code', header: 'Code', sortKey: 'code', render: (b) => <span className="font-mono text-xs font-semibold">{b.code}</span> },
    { key: 'name', header: 'Name', sortKey: 'name', render: (b) => <span className="font-medium text-slate-900">{b.name}{b.is_head_office && <Badge tone="blue" className="ml-2">Head office</Badge>}</span> },
    { key: 'city', header: 'City', hideOnMobile: true, render: (b) => b.city ?? '—' },
    { key: 'phone', header: 'Phone', hideOnMobile: true, render: (b) => b.phone ?? '—' },
    { key: 'status', header: 'Status', render: (b) => <StatusBadge active={b.is_active} /> },
    {
      key: 'actions', header: '', className: 'text-right',
      render: (b) => (
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEditing(b)}>{ability.can('branches.edit', b.id) ? 'Edit' : 'View'}</Button>
          {ability.can('branches.edit', b.id) && (
            <Button size="sm" variant="ghost" onClick={() => setToggle(b)}>{b.is_active ? 'Deactivate' : 'Activate'}</Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        title="Branches"
        description="Physical locations of your business. You only see branches you have access to."
        actions={canCreate && <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" aria-hidden /> New branch</Button>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center">
          <div className="flex-1"><SearchInput value={state.search} onChange={setSearch} placeholder="Search by name, code or city" label="Search branches" /></div>
          <StatusFilter value={state.status} onChange={setStatus} label="Branch status" />
        </div>
        <DataTable
          caption="Branches"
          columns={columns}
          rows={query.data?.rows}
          rowKey={(b) => b.id}
          loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null}
          onRetry={() => void query.refetch()}
          sort={state.sort}
          onSortChange={setSort}
          emptyTitle={state.search || state.status !== 'all' ? 'No branches match your filters' : 'No branches yet'}
          emptyDescription={state.search || state.status !== 'all' ? 'Try a different search or status.' : 'Create the first branch to get started.'}
        />
        <Pagination page={state.page} pageSize={PAGE_SIZE} total={query.data?.total} onPageChange={setPage} loading={query.isFetching} />
      </Card>

      <BranchForm
        open={editing !== null}
        branch={editing === 'new' ? null : editing}
        canEdit={editing === 'new' ? canCreate : editing ? ability.can('branches.edit', editing.id) : false}
        onClose={() => setEditing(null)}
      />
      <ConfirmDialog
        open={toggle !== null}
        title={toggle?.is_active ? 'Deactivate branch?' : 'Activate branch?'}
        message={toggle?.is_active
          ? `“${toggle.name}” will be marked inactive. History is kept; new activity can no longer be started there.`
          : `“${toggle?.name}” will become active again.`}
        confirmLabel={toggle?.is_active ? 'Deactivate' : 'Activate'}
        tone={toggle?.is_active ? 'danger' : 'primary'}
        loading={toggleActive.isPending}
        onConfirm={() => toggle && toggleActive.mutate(toggle)}
        onCancel={() => setToggle(null)}
      />
    </>
  )
}
