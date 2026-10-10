import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button, Card, DataTable, PageHeader, Pagination, SearchInput, Select, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { useSession } from '@/modules/session/SessionProvider'
import { PO_STATUSES, PO_STATUS_LABEL, listPurchaseOrders, money, type PoStatus, type PurchaseOrder } from '@/services/purchasing'
import { listSupplierOptions } from '@/services/suppliers'
import { PurchaseOrderForm } from './PurchaseOrderForm'
import { PoStatusBadge } from './shared'

const PAGE_SIZE = 20

export function PurchaseOrdersPage() {
  const { ability } = useSession()
  const navigate = useNavigate()
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<PoStatus | ''>('')
  const [supplierId, setSupplierId] = useState('')
  const [creating, setCreating] = useState(false)

  const suppliers = useQuery({ queryKey: ['supplier-options'], queryFn: listSupplierOptions, staleTime: 60_000 })
  const params = { page, pageSize: PAGE_SIZE, search, status, supplierId }
  const query = useQuery({ queryKey: ['purchase-orders', params], queryFn: () => listPurchaseOrders(params), placeholderData: (prev) => prev })

  const columns: Column<PurchaseOrder>[] = [
    { key: 'no', header: 'Order', render: (o) => <Link to={`/purchasing/orders/${o.id}`} className="font-mono text-xs font-semibold text-brand-700 hover:underline">{o.po_number}</Link> },
    { key: 'supplier', header: 'Supplier', render: (o) => <span className="font-medium text-slate-900">{o.supplier?.name ?? '—'}</span> },
    { key: 'wh', header: 'Deliver to', hideOnMobile: true, render: (o) => o.warehouse?.name ?? '—' },
    { key: 'status', header: 'Status', render: (o) => <PoStatusBadge status={o.status} /> },
    { key: 'total', header: 'Total', className: 'text-right', render: (o) => <span className="whitespace-nowrap tabular-nums">{money(o.total_amount, o.currency_code)}</span> },
    { key: 'date', header: 'Created', hideOnMobile: true, render: (o) => <span className="whitespace-nowrap text-slate-600">{formatDateTime(o.created_at)}</span> },
  ]

  return (
    <>
      <PageHeader
        title="Purchase orders"
        description="Orders to suppliers. A draft is submitted for approval; once approved it can be received into stock."
        actions={ability.canAnywhere('purchasing.create') && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> New order</Button>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center">
          <div className="flex-1"><SearchInput value={search} onChange={(v) => { setSearch(v); setPage(0) }} placeholder="Search by order number, e.g. PO-000012" label="Search orders" /></div>
          <div className="w-full lg:w-52">
            <label htmlFor="po-status" className="sr-only">Status</label>
            <Select id="po-status" value={status} onChange={(e) => { setStatus(e.target.value as PoStatus | ''); setPage(0) }}>
              <option value="">All statuses</option>
              {PO_STATUSES.map((s) => <option key={s} value={s}>{PO_STATUS_LABEL[s]}</option>)}
            </Select>
          </div>
          <div className="w-full lg:w-60">
            <label htmlFor="po-supplier" className="sr-only">Supplier</label>
            <Select id="po-supplier" value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setPage(0) }}>
              <option value="">All suppliers</option>
              {(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>
        </div>
        <DataTable
          caption="Purchase orders"
          columns={columns}
          rows={query.data?.rows}
          rowKey={(o) => o.id}
          loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null}
          onRetry={() => void query.refetch()}
          emptyTitle={search || status || supplierId ? 'No orders match' : 'No purchase orders yet'}
          emptyDescription={search || status || supplierId ? 'Try clearing a filter.' : 'Create an order for a supplier from their price list or from scratch.'}
        />
        <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>
      <PurchaseOrderForm open={creating} order={null} lines={null} onClose={() => setCreating(false)} onSaved={(id) => navigate(`/purchasing/orders/${id}`)} />
    </>
  )
}
