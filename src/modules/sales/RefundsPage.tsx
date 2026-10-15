import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, DataTable, PageHeader, Pagination, SearchInput, Select, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { listCustomerOptions } from '@/services/customers'
import { listRefunds, type CustomerRefund } from '@/services/refunds'
import { RECEIPT_METHOD_LABEL, moneyFmt, type ReceiptMethod } from '@/services/sales'

const PAGE_SIZE = 20

export function RefundsPage() {
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [customerId, setCustomerId] = useState('')
  const customers = useQuery({ queryKey: ['customer-options'], queryFn: listCustomerOptions, staleTime: 60_000 })
  const params = { page, pageSize: PAGE_SIZE, search, customerId }
  const query = useQuery({ queryKey: ['refunds', params], queryFn: () => listRefunds(params), placeholderData: (p) => p })

  const columns: Column<CustomerRefund>[] = [
    { key: 'no', header: 'Refund', render: (r) => <span className="font-mono text-xs font-semibold">{r.refund_number}</span> },
    { key: 'cust', header: 'Customer', render: (r) => <Link to={`/sales/customers/${r.customer_id}`} className="font-medium text-slate-900 hover:underline">{r.customer?.name ?? '—'}</Link> },
    {
      key: 'src', header: 'From', hideOnMobile: true,
      render: (r) => (r.credit_note_id ? <Link to={`/sales/credit-notes/${r.credit_note_id}`} className="font-mono text-xs text-slate-600 hover:underline">{r.credit_note?.credit_note_number}</Link> : <span className="font-mono text-xs text-slate-600">{r.receipt?.receipt_number}</span>),
    },
    { key: 'how', header: 'Paid back by', hideOnMobile: true, render: (r) => <span className="text-slate-600">{RECEIPT_METHOD_LABEL[r.method as ReceiptMethod] ?? r.method}{r.reference ? ` · ${r.reference}` : ''}{r.pos_session_id ? ' · from till' : ''}</span> },
    { key: 'amt', header: 'Amount', className: 'text-right', render: (r) => <span className="tabular-nums">{moneyFmt(r.amount)}</span> },
    { key: 'date', header: 'Date', hideOnMobile: true, render: (r) => <span className="whitespace-nowrap text-slate-600">{formatDateTime(r.created_at)}</span> },
  ]

  return (
    <>
      <PageHeader title="Refunds" description="Money paid back to customers from unused credit. To refund, open the customer, credit note or payment that holds the credit." />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center">
          <div className="flex-1"><SearchInput value={search} onChange={(v) => { setSearch(v); setPage(0) }} placeholder="Search by refund number or reference" label="Search refunds" /></div>
          <div className="w-full lg:w-60">
            <label htmlFor="rf-customer" className="sr-only">Customer</label>
            <Select id="rf-customer" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setPage(0) }}>
              <option value="">All customers</option>
              {(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
        </div>
        <DataTable
          caption="Refunds" columns={columns} rows={query.data?.rows} rowKey={(r) => r.id} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()}
          emptyTitle={search || customerId ? 'No refunds match' : 'No refunds yet'} emptyDescription="Refunds appear here once unused credit is paid back to a customer."
        />
        <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>
    </>
  )
}
