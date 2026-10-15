import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, DataTable, PageHeader, Pagination, SearchInput, Select, useToast, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { ReasonDialog } from '@/modules/purchasing/shared'
import { useSession } from '@/modules/session/SessionProvider'
import { listCustomerOptions } from '@/services/customers'
import { RECEIPT_METHOD_LABEL, allocateReceipt, listReceipts, moneyFmt, voidReceipt, type CustomerReceipt, type ReceiptMethod } from '@/services/sales'
import { RecordReceiptDialog } from './RecordReceiptDialog'

const PAGE_SIZE = 20

export function ReceiptsPage() {
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [status, setStatus] = useState<'POSTED' | 'VOID' | ''>('')
  const [recording, setRecording] = useState(false)
  const [voiding, setVoiding] = useState<CustomerReceipt | null>(null)
  const [voidError, setVoidError] = useState<string | null>(null)

  const customers = useQuery({ queryKey: ['customer-options'], queryFn: listCustomerOptions, staleTime: 60_000 })
  const params = { page, pageSize: PAGE_SIZE, search, customerId, status }
  const query = useQuery({ queryKey: ['customer-receipts', params], queryFn: () => listReceipts(params), placeholderData: (p) => p })
  const refresh = () => Promise.all(['customer-receipts', 'open-invoices', 'customer-credit', 'customer-statement', 'receivables', 'sales-invoices', 'sales-invoice', 'invoice-payments', 'dashboard'].map((k) => qc.invalidateQueries({ queryKey: [k] })))

  const allocate = useMutation({
    mutationFn: (id: string) => allocateReceipt(id),
    onSuccess: async (n) => { toast.success(n > 0 ? `${moneyFmt(n)} applied to open invoices.` : 'Nothing to apply: the customer has no open invoices.'); await refresh() },
    onError: (e) => toast.error(toAppError(e).message),
  })
  const doVoid = useMutation({
    mutationFn: (reason: string) => voidReceipt(voiding!.id, reason),
    onSuccess: async () => { toast.success('Payment voided; its invoices are owed again.'); setVoiding(null); await refresh() },
    onError: (e) => setVoidError(toAppError(e).message),
  })

  const columns: Column<CustomerReceipt>[] = [
    { key: 'no', header: 'Receipt', render: (r) => <span className="font-mono text-xs font-semibold">{r.receipt_number}</span> },
    { key: 'cust', header: 'Customer', render: (r) => <Link to={`/sales/customers/${r.customer_id}`} className="font-medium text-slate-900 hover:underline">{r.customer?.name ?? '—'}</Link> },
    { key: 'how', header: 'How', hideOnMobile: true, render: (r) => <span className="text-slate-600">{RECEIPT_METHOD_LABEL[r.method as ReceiptMethod] ?? r.method}{r.reference ? ` · ${r.reference}` : ''}</span> },
    { key: 'amt', header: 'Amount', className: 'text-right', render: (r) => <span className="tabular-nums">{moneyFmt(r.amount)}</span> },
    { key: 'un', header: 'Unapplied', className: 'text-right', render: (r) => (r.status === 'POSTED' && Number(r.unallocated_amount) > 0 ? <Badge tone="amber">{moneyFmt(r.unallocated_amount)}</Badge> : <span className="text-slate-400">—</span>) },
    { key: 'status', header: 'Status', render: (r) => (r.status === 'VOID' ? <Badge tone="slate">Voided</Badge> : <Badge tone="green">Posted</Badge>) },
    { key: 'date', header: 'Date', hideOnMobile: true, render: (r) => <span className="whitespace-nowrap text-slate-600">{formatDateTime(r.created_at)}</span> },
    {
      key: 'act', header: '', className: 'text-right',
      render: (r) => r.status !== 'POSTED' ? null : (
        <span className="flex justify-end gap-2">
          {Number(r.unallocated_amount) > 0 && ability.can('receipts.create', r.branch_id) && <Button size="sm" variant="secondary" loading={allocate.isPending && allocate.variables === r.id} onClick={() => allocate.mutate(r.id)}>Apply</Button>}
          {ability.can('receipts.void', r.branch_id) && <Button size="sm" variant="ghost" onClick={() => { setVoidError(null); setVoiding(r) }}>Void</Button>}
        </span>
      ),
    },
  ]
  const filtered = Boolean(search || customerId || status)

  return (
    <>
      <PageHeader
        title="Payments received"
        description="Money from customers. Each payment pays invoices (oldest due first unless chosen); anything left over stays as the customer’s credit."
        actions={ability.canAnywhere('receipts.create') && <Button onClick={() => setRecording(true)}><Plus className="h-4 w-4" aria-hidden /> Record payment</Button>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center">
          <div className="flex-1"><SearchInput value={search} onChange={(v) => { setSearch(v); setPage(0) }} placeholder="Search by receipt number or reference" label="Search payments" /></div>
          <div className="w-full lg:w-60">
            <label htmlFor="rc-customer" className="sr-only">Customer</label>
            <Select id="rc-customer" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setPage(0) }}>
              <option value="">All customers</option>
              {(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <div className="w-full lg:w-40">
            <label htmlFor="rc-status" className="sr-only">Status</label>
            <Select id="rc-status" value={status} onChange={(e) => { setStatus(e.target.value as 'POSTED' | 'VOID' | ''); setPage(0) }}>
              <option value="">All</option><option value="POSTED">Posted</option><option value="VOID">Voided</option>
            </Select>
          </div>
        </div>
        <DataTable
          caption="Payments received" columns={columns} rows={query.data?.rows} rowKey={(r) => r.id} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()}
          emptyTitle={filtered ? 'No payments match' : 'No payments yet'} emptyDescription={filtered ? 'Try clearing a filter.' : 'Record the first payment from a customer.'}
        />
        <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>
      {recording && <RecordReceiptDialog customers={customers.data ?? []} onClose={() => setRecording(false)} />}
      <ReasonDialog
        open={voiding !== null} title={`Void ${voiding?.receipt_number ?? 'payment'}`} confirmLabel="Void payment" tone="danger"
        description="Use this for a payment recorded by mistake or a bounced cheque. The invoices it paid become owed again."
        busy={doVoid.isPending} error={voidError} onConfirm={(r) => doVoid.mutate(r)} onClose={() => setVoiding(null)}
      />
    </>
  )
}
