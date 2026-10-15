import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Badge, Card, DataTable, PageHeader, Pagination, SearchInput, Select, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { CREDIT_REASON_LABEL, CREDIT_STATUSES, CREDIT_STATUS_LABEL, listCreditNotes, type CreditNote, type CreditReason, type CreditStatus } from '@/services/creditNotes'
import { listCustomerOptions } from '@/services/customers'
import { moneyFmt } from '@/services/sales'

const PAGE_SIZE = 20
const TONE = { DRAFT: 'amber', POSTED: 'green', CANCELLED: 'slate' } as const

export function CreditStatusBadge({ status }: { status: string }) {
  return <Badge tone={TONE[status as CreditStatus] ?? 'slate'}>{CREDIT_STATUS_LABEL[status as CreditStatus] ?? status}</Badge>
}

export function CreditNotesPage() {
  const [sp] = useSearchParams()
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<CreditStatus | ''>('')
  const [customerId, setCustomerId] = useState(sp.get('customer') ?? '')
  const [unusedOnly, setUnusedOnly] = useState(false)
  const customers = useQuery({ queryKey: ['customer-options'], queryFn: listCustomerOptions, staleTime: 60_000 })
  const params = { page, pageSize: PAGE_SIZE, search, status, customerId, invoiceId: '', unusedOnly }
  const query = useQuery({ queryKey: ['credit-notes', params], queryFn: () => listCreditNotes(params), placeholderData: (p) => p })

  const columns: Column<CreditNote>[] = [
    { key: 'no', header: 'Credit note', render: (n) => <Link to={`/sales/credit-notes/${n.id}`} className="font-mono text-xs font-semibold text-brand-700 hover:underline">{n.credit_note_number ?? 'Draft'}</Link> },
    { key: 'cust', header: 'Customer', render: (n) => <span className="font-medium text-slate-900">{n.customer?.name ?? '—'}</span> },
    { key: 'inv', header: 'Invoice', hideOnMobile: true, render: (n) => <Link to={`/sales/invoices/${n.sales_invoice_id}`} className="font-mono text-xs text-slate-600 hover:underline">{n.invoice?.invoice_number ?? '—'}</Link> },
    { key: 'why', header: 'Reason', hideOnMobile: true, render: (n) => <span className="text-slate-600">{CREDIT_REASON_LABEL[n.reason_code as CreditReason] ?? n.reason_code}</span> },
    { key: 'status', header: 'Status', render: (n) => <CreditStatusBadge status={n.status} /> },
    { key: 'total', header: 'Total', className: 'text-right', render: (n) => <span className="whitespace-nowrap tabular-nums">{moneyFmt(n.total_amount)}</span> },
    { key: 'unused', header: 'Unused', className: 'text-right', render: (n) => (n.status === 'POSTED' && Number(n.unapplied_amount) > 0 ? <Badge tone="amber">{moneyFmt(n.unapplied_amount)}</Badge> : <span className="text-slate-400">—</span>) },
    { key: 'date', header: 'Date', hideOnMobile: true, render: (n) => <span className="whitespace-nowrap text-slate-600">{formatDateTime(n.posted_at ?? n.created_at)}</span> },
  ]
  const filtered = Boolean(search || status || customerId || unusedOnly)

  return (
    <>
      <PageHeader title="Credit notes" description="Returned goods and price corrections on posted invoices. To raise one, open the invoice and choose “Credit note”." />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center">
          <div className="flex-1"><SearchInput value={search} onChange={(v) => { setSearch(v); setPage(0) }} placeholder="Search by credit note number" label="Search credit notes" /></div>
          <div className="w-full lg:w-44">
            <label htmlFor="cn-status" className="sr-only">Status</label>
            <Select id="cn-status" value={status} onChange={(e) => { setStatus(e.target.value as CreditStatus | ''); setPage(0) }}>
              <option value="">All statuses</option>
              {CREDIT_STATUSES.map((s) => <option key={s} value={s}>{CREDIT_STATUS_LABEL[s]}</option>)}
            </Select>
          </div>
          <div className="w-full lg:w-60">
            <label htmlFor="cn-customer" className="sr-only">Customer</label>
            <Select id="cn-customer" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setPage(0) }}>
              <option value="">All customers</option>
              {(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" className="h-4 w-4" checked={unusedOnly} onChange={(e) => { setUnusedOnly(e.target.checked); setPage(0) }} /> With unused credit</label>
        </div>
        <DataTable
          caption="Credit notes" columns={columns} rows={query.data?.rows} rowKey={(n) => n.id} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()}
          emptyTitle={filtered ? 'No credit notes match' : 'No credit notes yet'} emptyDescription={filtered ? 'Try clearing a filter.' : 'Credit notes appear here once goods are returned or a price is corrected.'}
        />
        <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>
    </>
  )
}
