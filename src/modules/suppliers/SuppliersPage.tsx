import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Card, ConfirmDialog, DataTable, PageHeader, Pagination, SearchInput, StatusBadge, useToast, type Column } from '@/components/ui'
import { useTableState } from '@/hooks/useTableState'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import { StatusFilter } from '@/modules/shared/StatusFilter'
import { listSuppliers, setSupplierActive, type Supplier } from '@/services/suppliers'
import { SUPPLIER_TYPE_LABEL, SupplierForm } from './SupplierForm'
import { SupplierPricesDialog } from './SupplierPricesDialog'

const PAGE_SIZE = 20

/** Days until the licence expires (negative = expired); null when no expiry is recorded. */
export function licenceDaysLeft(expiry: string | null, today = new Date()): number | null {
  if (!expiry) return null
  const end = new Date(`${expiry}T00:00:00Z`).getTime()
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  return Math.round((end - start) / 86_400_000)
}

function LicenceBadge({ s }: { s: Supplier }) {
  const d = licenceDaysLeft(s.licence_expiry)
  if (d === null) return <span className="text-slate-400">—</span>
  if (d < 0) return <Badge tone="red">Expired {s.licence_expiry}</Badge>
  if (d <= 60) return <Badge tone="amber">Expires in {d} d</Badge>
  return <span className="text-sm text-slate-600">{s.licence_expiry}</span>
}

export function SuppliersPage() {
  const { ability } = useSession()
  const toast = useToast()
  const qc = useQueryClient()
  const { state, setPage, setSearch, setStatus, setSort } = useTableState<'name' | 'code' | 'licence_expiry'>({ key: 'name', direction: 'asc' })
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null)
  const [pricing, setPricing] = useState<Supplier | null>(null)
  const [toggle, setToggle] = useState<Supplier | null>(null)

  const params = { page: state.page, pageSize: PAGE_SIZE, search: state.search, status: state.status, sortKey: state.sort.key, sortDirection: state.sort.direction }
  const query = useQuery({ queryKey: ['suppliers', params], queryFn: () => listSuppliers(params), placeholderData: (p) => p })

  const toggleActive = useMutation({
    mutationFn: (s: Supplier) => setSupplierActive(s.id, !s.is_active),
    onSuccess: async (_d, s) => { toast.success(s.is_active ? 'Supplier deactivated.' : 'Supplier activated.'); await qc.invalidateQueries({ queryKey: ['suppliers'] }); setToggle(null) },
    onError: (e) => { toast.error(toAppError(e).message); setToggle(null) },
  })

  const canCreate = ability.can('suppliers.create')
  const canEdit = ability.can('suppliers.edit')
  const columns: Column<Supplier>[] = [
    { key: 'code', header: 'Code', sortKey: 'code', render: (s) => <span className="font-mono text-xs font-semibold">{s.code}</span> },
    { key: 'name', header: 'Supplier', sortKey: 'name', render: (s) => <span className="block min-w-0"><span className="font-medium text-slate-900">{s.name}</span><span className="block text-xs text-slate-500">{SUPPLIER_TYPE_LABEL[s.supplier_type as keyof typeof SUPPLIER_TYPE_LABEL]}{s.contact_name ? ` · ${s.contact_name}` : ''}</span></span> },
    { key: 'terms', header: 'Terms', hideOnMobile: true, render: (s) => `${s.payment_terms_days} days` },
    { key: 'licence', header: 'Licence', sortKey: 'licence_expiry', hideOnMobile: true, render: (s) => <LicenceBadge s={s} /> },
    { key: 'status', header: 'Status', render: (s) => <StatusBadge active={s.is_active} /> },
    {
      key: 'actions', header: '', className: 'text-right',
      render: (s) => (
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => setPricing(s)}>Price list</Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>{canEdit ? 'Edit' : 'View'}</Button>
          {canEdit && <Button size="sm" variant="ghost" onClick={() => setToggle(s)}>{s.is_active ? 'Deactivate' : 'Activate'}</Button>}
        </div>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        title="Suppliers"
        description="Who you buy from: licence, payment terms, and the products and costs on their price list."
        actions={canCreate && <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" aria-hidden /> New supplier</Button>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center">
          <div className="flex-1"><SearchInput value={state.search} onChange={setSearch} placeholder="Search by name, code, licence or contact" label="Search suppliers" /></div>
          <StatusFilter value={state.status} onChange={setStatus} label="Supplier status" />
        </div>
        <DataTable
          caption="Suppliers"
          columns={columns}
          rows={query.data?.rows}
          rowKey={(s) => s.id}
          loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null}
          onRetry={() => void query.refetch()}
          sort={state.sort}
          onSortChange={setSort}
          emptyTitle={state.search || state.status !== 'all' ? 'No suppliers match' : 'No suppliers yet'}
          emptyDescription={state.search || state.status !== 'all' ? 'Try a different search or status.' : 'Add the first supplier to start building price lists.'}
        />
        <Pagination page={state.page} pageSize={PAGE_SIZE} total={query.data?.total} onPageChange={setPage} loading={query.isFetching} />
      </Card>

      <SupplierForm open={editing !== null} supplier={editing === 'new' ? null : editing} canEdit={editing === 'new' ? canCreate : canEdit} onClose={() => setEditing(null)} />
      <SupplierPricesDialog supplier={pricing} canEdit={canEdit} onClose={() => setPricing(null)} />
      <ConfirmDialog
        open={toggle !== null}
        title={toggle?.is_active ? 'Deactivate supplier?' : 'Activate supplier?'}
        message={toggle?.is_active ? `“${toggle.name}” will be marked inactive. Its history and price list are kept.` : `“${toggle?.name}” will become active again.`}
        confirmLabel={toggle?.is_active ? 'Deactivate' : 'Activate'}
        tone={toggle?.is_active ? 'danger' : 'primary'}
        loading={toggleActive.isPending}
        onConfirm={() => toggle && toggleActive.mutate(toggle)}
        onCancel={() => setToggle(null)}
      />
    </>
  )
}
