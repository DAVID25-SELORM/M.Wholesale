import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, DataTable, PageHeader, Pagination, SearchInput, Select, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import { listCustomerOptions } from '@/services/customers'
import { QUOTATION_STATUSES, QUOTATION_STATUS_LABEL, listQuotations, type Quotation, type QuotationStatus } from '@/services/orders'
import { moneyFmt } from '@/services/sales'

const PAGE_SIZE = 20
const TONE = { DRAFT: 'amber', SENT: 'blue', ACCEPTED: 'green', REJECTED: 'red', CANCELLED: 'slate' } as const
const today = () => new Date().toISOString().slice(0, 10)

export const isExpired = (q: Pick<Quotation, 'status' | 'valid_until'>) => q.status === 'SENT' && q.valid_until < today()

export function QuotationStatusBadge({ q }: { q: Pick<Quotation, 'status' | 'valid_until'> }) {
  if (isExpired(q)) return <Badge tone="red">Expired</Badge>
  return <Badge tone={TONE[q.status as QuotationStatus] ?? 'slate'}>{QUOTATION_STATUS_LABEL[q.status as QuotationStatus] ?? q.status}</Badge>
}

export function QuotationsPage() {
  const { ability } = useSession()
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<QuotationStatus | ''>('')
  const [customerId, setCustomerId] = useState('')
  const customers = useQuery({ queryKey: ['customer-options'], queryFn: listCustomerOptions, staleTime: 60_000 })
  const params = { page, pageSize: PAGE_SIZE, search, status, customerId }
  const query = useQuery({ queryKey: ['quotations', params], queryFn: () => listQuotations(params), placeholderData: (p) => p })

  const columns: Column<Quotation>[] = [
    { key: 'no', header: 'Quotation', render: (x) => <Link to={`/sales/quotations/${x.id}`} className="font-mono text-xs font-semibold text-brand-700 hover:underline">{x.quotation_number ?? 'Draft'}</Link> },
    { key: 'cust', header: 'Customer', render: (x) => <span className="font-medium text-slate-900">{x.customer?.name ?? '—'}</span> },
    { key: 'valid', header: 'Valid until', hideOnMobile: true, render: (x) => <span className="whitespace-nowrap text-slate-600">{x.valid_until}</span> },
    { key: 'status', header: 'Status', render: (x) => <QuotationStatusBadge q={x} /> },
    { key: 'total', header: 'Total', className: 'text-right', render: (x) => <span className="whitespace-nowrap tabular-nums">{moneyFmt(x.total_amount)}</span> },
    { key: 'order', header: 'Order', hideOnMobile: true, render: (x) => (x.converted_order_id ? <Link to={`/sales/orders/${x.converted_order_id}`} className="font-mono text-xs text-slate-600 hover:underline">{x.order?.order_number ?? 'Draft order'}</Link> : '—') },
  ]
  const filtered = Boolean(search || status || customerId)

  return (
    <>
      <PageHeader
        title="Quotations"
        description="Offers to customers at stated prices. When the customer accepts, the quotation becomes a sales order."
        actions={ability.canAnywhere('quotations.create') && <Link to="/sales/quotations/new"><Button><Plus className="h-4 w-4" aria-hidden /> New quotation</Button></Link>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center">
          <div className="flex-1"><SearchInput value={search} onChange={(v) => { setSearch(v); setPage(0) }} placeholder="Search by quotation number or reference" label="Search quotations" /></div>
          <div className="w-full lg:w-44">
            <label htmlFor="qt-status" className="sr-only">Status</label>
            <Select id="qt-status" value={status} onChange={(e) => { setStatus(e.target.value as QuotationStatus | ''); setPage(0) }}>
              <option value="">All statuses</option>
              {QUOTATION_STATUSES.map((s) => <option key={s} value={s}>{QUOTATION_STATUS_LABEL[s]}</option>)}
            </Select>
          </div>
          <div className="w-full lg:w-60">
            <label htmlFor="qt-customer" className="sr-only">Customer</label>
            <Select id="qt-customer" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setPage(0) }}>
              <option value="">All customers</option>
              {(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
        </div>
        <DataTable
          caption="Quotations" columns={columns} rows={query.data?.rows} rowKey={(x) => x.id} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()}
          emptyTitle={filtered ? 'No quotations match' : 'No quotations yet'} emptyDescription={filtered ? 'Try clearing a filter.' : 'Create a quotation for a customer who has asked for prices.'}
        />
        <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>
    </>
  )
}
