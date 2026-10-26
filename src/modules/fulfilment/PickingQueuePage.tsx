import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Card, Checkbox, DataTable, PageHeader, SearchInput, Select, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { FULFILMENT_STATUS_LABEL, PRIORITY_LABEL, getQueue, type QueueRow } from '@/services/fulfilment'

const TONE: Record<string, 'amber' | 'blue' | 'green' | 'slate' | 'red' | 'purple'> = { RELEASED: 'amber', PICKING: 'blue', PICKED: 'green', PACKING: 'blue', PACKED: 'green', READY: 'green', CANCELLED: 'slate' }

export function FulfilmentStatusBadge({ status }: { status: string }) {
  return <Badge tone={TONE[status] ?? 'slate'}>{FULFILMENT_STATUS_LABEL[status] ?? status}</Badge>
}

export function PickingQueuePage() {
  const [status, setStatus] = useState('OPEN')
  const [mine, setMine] = useState(false)
  const [search, setSearch] = useState('')
  // "OPEN" is a screen-only choice: everything still to be picked
  const query = useQuery({ queryKey: ['fulfilment-queue', status === 'OPEN' ? null : status || null, mine], queryFn: () => getQueue(status === 'OPEN' || status === '' ? null : status, mine), refetchInterval: 30_000 })
  const s = search.trim().toLowerCase()
  const rows = (query.data ?? []).filter((r) => (status === 'OPEN' ? r.status === 'RELEASED' || r.status === 'PICKING' : true)
    && (!s || `${r.order_number} ${r.invoice_number ?? ''} ${r.customer_name}`.toLowerCase().includes(s)))

  const columns: Column<QueueRow>[] = [
    { key: 'no', header: 'Order', render: (r) => <Link to={`/warehouse/picking/${r.id}`} className="font-mono text-xs font-semibold text-brand-700 hover:underline">{r.order_number}</Link> },
    { key: 'cust', header: 'Customer', render: (r) => <span className="font-medium text-slate-900">{r.customer_name}</span> },
    { key: 'inv', header: 'Invoice', hideOnMobile: true, render: (r) => <span className="font-mono text-xs text-slate-600">{r.invoice_number ?? '—'}</span> },
    { key: 'pri', header: 'Priority', render: (r) => <Badge tone={r.priority === 1 ? 'red' : r.priority === 3 ? 'slate' : 'blue'}>{PRIORITY_LABEL[r.priority]}</Badge> },
    { key: 'status', header: 'Status', render: (r) => <span className="inline-flex flex-wrap gap-1"><FulfilmentStatusBadge status={r.status} />{r.open_exceptions > 0 && <Badge tone="red">Short pick</Badge>}</span> },
    { key: 'progress', header: 'Lines', className: 'text-right', render: (r) => `${r.lines_done} / ${r.line_count}` },
    { key: 'picker', header: 'Picker', hideOnMobile: true, render: (r) => r.picker_name ?? '—' },
    { key: 'by', header: 'Needed by', hideOnMobile: true, render: (r) => r.required_by ?? '—' },
    { key: 'rel', header: 'Released', hideOnMobile: true, render: (r) => <span className="whitespace-nowrap text-slate-600">{formatDateTime(r.released_at)}</span> },
  ]

  return (
    <>
      <PageHeader title="Picking" description="Posted invoices released to the warehouse, in order of priority. Open an order to claim it and confirm each line. To release an invoice, open it from Sales → Invoices and choose “Release to warehouse”." />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center">
          <div className="flex-1"><SearchInput value={search} onChange={setSearch} placeholder="Search by order, invoice or customer" label="Search orders" /></div>
          <div className="w-full sm:w-48">
            <label className="sr-only" htmlFor="pick-status">Order status</label>
            <Select id="pick-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="OPEN">To pick (open)</option>
              <option value="PICKED">Picked</option>
              <option value="HOLD">On hold</option>
              <option value="CANCELLED">Cancelled</option>
              <option value="">All</option>
            </Select>
          </div>
          <Checkbox label="My tasks" checked={mine} onChange={(e) => setMine(e.target.checked)} />
        </div>
        <DataTable
          caption="Fulfilment orders"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null}
          onRetry={() => void query.refetch()}
          emptyTitle={s || mine || status !== 'OPEN' ? 'No orders match' : 'Nothing waiting to be picked'}
          emptyDescription="Orders appear here when a posted invoice is released to the warehouse."
        />
      </Card>
    </>
  )
}
