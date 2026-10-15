import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Badge, Button, Card, DataTable, PageHeader, Pagination, SearchInput, Select, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { useSession } from '@/modules/session/SessionProvider'
import { listCustomerOptions } from '@/services/customers'
import { INVOICE_STATUSES, SALES_STATUS_LABEL, listSalesInvoices, moneyFmt, type SalesInvoice, type SalesStatus } from '@/services/sales'

const PAGE_SIZE = 20
const TONE = { DRAFT: 'amber', POSTED: 'green', CANCELLED: 'slate', REVERSED: 'red' } as const

export function SalesStatusBadge({ status }: { status: string }) {
  return <Badge tone={TONE[status as SalesStatus] ?? 'slate'}>{SALES_STATUS_LABEL[status as SalesStatus] ?? status}</Badge>
}

export function SalesInvoicesPage() {
  const { ability } = useSession()
  const [sp] = useSearchParams()
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<SalesStatus | ''>('')
  const [customerId, setCustomerId] = useState(sp.get('customer') ?? '')
  const [unpaidOnly, setUnpaidOnly] = useState(false)
  const customers = useQuery({ queryKey: ['customer-options'], queryFn: listCustomerOptions, staleTime: 60_000 })
  const params = { page, pageSize: PAGE_SIZE, search, status, customerId, unpaidOnly }
  const query = useQuery({ queryKey: ['sales-invoices', params], queryFn: () => listSalesInvoices(params), placeholderData: (p) => p })
  const today = new Date().toISOString().slice(0, 10)

  const columns: Column<SalesInvoice>[] = [
    { key: 'no', header: 'Invoice', render: (i) => <Link to={`/sales/invoices/${i.id}`} className="font-mono text-xs font-semibold text-brand-700 hover:underline">{i.invoice_number ?? 'Draft'}</Link> },
    { key: 'cust', header: 'Customer', render: (i) => <span className="font-medium text-slate-900">{i.customer?.name ?? '—'}</span> },
    { key: 'wh', header: 'From', hideOnMobile: true, render: (i) => i.warehouse?.name ?? '—' },
    { key: 'status', header: 'Status', render: (i) => <SalesStatusBadge status={i.status} /> },
    { key: 'total', header: 'Total', className: 'text-right', render: (i) => <span className="whitespace-nowrap tabular-nums">{moneyFmt(i.total_amount)}</span> },
    {
      key: 'bal', header: 'Owed', className: 'text-right',
      render: (i) => i.status !== 'POSTED' ? '—' : Number(i.balance_due) > 0
        ? <span className={`whitespace-nowrap tabular-nums ${i.due_date && i.due_date < today ? 'font-semibold text-red-700' : ''}`}>{moneyFmt(i.balance_due)}</span>
        : <span className="text-green-700">Paid</span>,
    },
    { key: 'date', header: 'Date', hideOnMobile: true, render: (i) => <span className="whitespace-nowrap text-slate-600">{formatDateTime(i.posted_at ?? i.created_at)}</span> },
  ]
  const filtered = Boolean(search || status || customerId || unpaidOnly)

  return (
    <>
      <PageHeader
        title="Sales invoices"
        description="Draft an invoice, then post it: stock leaves the warehouse earliest-expiry-first and the amount goes on the customer’s account."
        actions={ability.canAnywhere('sales.create') && <Link to={`/sales/invoices/new${customerId ? `?customer=${customerId}` : ''}`}><Button><Plus className="h-4 w-4" aria-hidden /> New invoice</Button></Link>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center">
          <div className="flex-1"><SearchInput value={search} onChange={(v) => { setSearch(v); setPage(0) }} placeholder="Search by invoice number or customer reference" label="Search invoices" /></div>
          <div className="w-full lg:w-44">
            <label htmlFor="si-status" className="sr-only">Status</label>
            <Select id="si-status" value={status} onChange={(e) => { setStatus(e.target.value as SalesStatus | ''); setPage(0) }}>
              <option value="">All statuses</option>
              {INVOICE_STATUSES.map((s) => <option key={s} value={s}>{SALES_STATUS_LABEL[s]}</option>)}
            </Select>
          </div>
          <div className="w-full lg:w-60">
            <label htmlFor="si-customer" className="sr-only">Customer</label>
            <Select id="si-customer" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setPage(0) }}>
              <option value="">All customers</option>
              {(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" className="h-4 w-4" checked={unpaidOnly} onChange={(e) => { setUnpaidOnly(e.target.checked); setPage(0) }} /> Unpaid only</label>
        </div>
        <DataTable
          caption="Sales invoices" columns={columns} rows={query.data?.rows} rowKey={(i) => i.id} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()}
          emptyTitle={filtered ? 'No invoices match' : 'No invoices yet'} emptyDescription={filtered ? 'Try clearing a filter.' : 'Create your first invoice for a customer.'}
        />
        <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>
    </>
  )
}
