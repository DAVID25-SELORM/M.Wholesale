import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, DataTable, PageHeader, Pagination, SearchInput, Select, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import { listCustomerOptions } from '@/services/customers'
import { ORDER_STATUSES, ORDER_STATUS_LABEL, listSalesOrders, type OrderStatus, type SalesOrder } from '@/services/orders'
import { moneyFmt } from '@/services/sales'

const PAGE_SIZE = 20
const TONE = { DRAFT: 'amber', CONFIRMED: 'blue', COMPLETED: 'green', CLOSED: 'slate', CANCELLED: 'slate' } as const

export function OrderStatusBadge({ status }: { status: string }) {
  return <Badge tone={TONE[status as OrderStatus] ?? 'slate'}>{ORDER_STATUS_LABEL[status as OrderStatus] ?? status}</Badge>
}

export function SalesOrdersPage() {
  const { ability } = useSession()
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<OrderStatus | ''>('')
  const [customerId, setCustomerId] = useState('')
  const [openOnly, setOpenOnly] = useState(false)
  const customers = useQuery({ queryKey: ['customer-options'], queryFn: listCustomerOptions, staleTime: 60_000 })
  const params = { page, pageSize: PAGE_SIZE, search, status, customerId, openOnly }
  const query = useQuery({ queryKey: ['sales-orders', params], queryFn: () => listSalesOrders(params), placeholderData: (p) => p })

  const columns: Column<SalesOrder>[] = [
    { key: 'no', header: 'Order', render: (x) => <Link to={`/sales/orders/${x.id}`} className="font-mono text-xs font-semibold text-brand-700 hover:underline">{x.order_number ?? 'Draft'}</Link> },
    { key: 'cust', header: 'Customer', render: (x) => <span className="font-medium text-slate-900">{x.customer?.name ?? '—'}</span> },
    { key: 'po', header: 'Their PO', hideOnMobile: true, render: (x) => <span className="text-slate-600">{x.customer_reference ?? '—'}</span> },
    { key: 'need', header: 'Needed by', hideOnMobile: true, render: (x) => <span className="whitespace-nowrap text-slate-600">{x.required_date ?? '—'}</span> },
    { key: 'status', header: 'Status', render: (x) => <OrderStatusBadge status={x.status} /> },
    { key: 'total', header: 'Total', className: 'text-right', render: (x) => <span className="whitespace-nowrap tabular-nums">{moneyFmt(x.total_amount)}</span> },
  ]
  const filtered = Boolean(search || status || customerId || openOnly)

  return (
    <>
      <PageHeader
        title="Sales orders"
        description="What customers have ordered. A confirmed order holds its stock for the customer until it is delivered, closed or cancelled."
        actions={ability.canAnywhere('orders.create') && <Link to="/sales/orders/new"><Button><Plus className="h-4 w-4" aria-hidden /> New order</Button></Link>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center">
          <div className="flex-1"><SearchInput value={search} onChange={(v) => { setSearch(v); setPage(0) }} placeholder="Search by order number or the customer’s PO" label="Search orders" /></div>
          <div className="w-full lg:w-44">
            <label htmlFor="so-status" className="sr-only">Status</label>
            <Select id="so-status" value={status} onChange={(e) => { setStatus(e.target.value as OrderStatus | ''); setPage(0) }}>
              <option value="">All statuses</option>
              {ORDER_STATUSES.map((s) => <option key={s} value={s}>{ORDER_STATUS_LABEL[s]}</option>)}
            </Select>
          </div>
          <div className="w-full lg:w-60">
            <label htmlFor="so-customer" className="sr-only">Customer</label>
            <Select id="so-customer" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setPage(0) }}>
              <option value="">All customers</option>
              {(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" className="h-4 w-4" checked={openOnly} onChange={(e) => { setOpenOnly(e.target.checked); setPage(0) }} /> Still to deliver</label>
        </div>
        <DataTable
          caption="Sales orders" columns={columns} rows={query.data?.rows} rowKey={(x) => x.id} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()}
          emptyTitle={filtered ? 'No orders match' : 'No orders yet'} emptyDescription={filtered ? 'Try clearing a filter.' : 'Create an order for a customer, or accept a quotation.'}
        />
        <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>
    </>
  )
}
