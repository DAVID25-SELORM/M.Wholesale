import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Card, DataTable, PageHeader, Pagination, SearchInput, Select, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { listCustomerOptions } from '@/services/customers'
import { DELIVERY_STATUSES, DELIVERY_STATUS_LABEL, listDeliveryNotes, type DeliveryNote, type DeliveryStatus } from '@/services/deliveries'

const PAGE_SIZE = 20
const TONE = { PREPARED: 'amber', DISPATCHED: 'blue', DELIVERED: 'green', FAILED: 'red', CANCELLED: 'slate' } as const

export function DeliveryStatusBadge({ status }: { status: string }) {
  return <Badge tone={TONE[status as DeliveryStatus] ?? 'slate'}>{DELIVERY_STATUS_LABEL[status as DeliveryStatus] ?? status}</Badge>
}

export function DeliveriesPage() {
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<DeliveryStatus | ''>('')
  const [customerId, setCustomerId] = useState('')
  const customers = useQuery({ queryKey: ['customer-options'], queryFn: listCustomerOptions, staleTime: 60_000 })
  const params = { page, pageSize: PAGE_SIZE, search, status, customerId }
  const query = useQuery({ queryKey: ['delivery-notes', params], queryFn: () => listDeliveryNotes(params), placeholderData: (p) => p })

  const columns: Column<DeliveryNote>[] = [
    { key: 'no', header: 'Delivery', render: (d) => <Link to={`/sales/deliveries/${d.id}`} className="font-mono text-xs font-semibold text-brand-700 hover:underline">{d.note_number}</Link> },
    { key: 'cust', header: 'Customer', render: (d) => <span className="font-medium text-slate-900">{d.customer?.name ?? '—'}</span> },
    { key: 'inv', header: 'Invoice', hideOnMobile: true, render: (d) => <Link to={`/sales/invoices/${d.sales_invoice_id}`} className="font-mono text-xs text-slate-600 hover:underline">{d.invoice?.invoice_number ?? '—'}</Link> },
    { key: 'status', header: 'Status', render: (d) => <DeliveryStatusBadge status={d.status} /> },
    { key: 'driver', header: 'Driver', hideOnMobile: true, render: (d) => <span className="text-slate-600">{d.driver_name ? `${d.driver_name}${d.vehicle_number ? ` · ${d.vehicle_number}` : ''}` : '—'}</span> },
    { key: 'pk', header: 'Packages', hideOnMobile: true, className: 'text-right', render: (d) => d.packages },
    { key: 'date', header: 'Prepared', hideOnMobile: true, render: (d) => <span className="whitespace-nowrap text-slate-600">{formatDateTime(d.prepared_at)}</span> },
  ]
  const filtered = Boolean(search || status || customerId)

  return (
    <>
      <PageHeader title="Deliveries" description="Delivery notes for posted invoices: the pick list for the warehouse, the driver, and proof of delivery. To start one, open a posted invoice and choose “Prepare delivery”." />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center">
          <div className="flex-1"><SearchInput value={search} onChange={(v) => { setSearch(v); setPage(0) }} placeholder="Search by delivery number, driver or vehicle" label="Search deliveries" /></div>
          <div className="w-full lg:w-44">
            <label htmlFor="dl-status" className="sr-only">Status</label>
            <Select id="dl-status" value={status} onChange={(e) => { setStatus(e.target.value as DeliveryStatus | ''); setPage(0) }}>
              <option value="">All statuses</option>
              {DELIVERY_STATUSES.map((s) => <option key={s} value={s}>{DELIVERY_STATUS_LABEL[s]}</option>)}
            </Select>
          </div>
          <div className="w-full lg:w-60">
            <label htmlFor="dl-customer" className="sr-only">Customer</label>
            <Select id="dl-customer" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setPage(0) }}>
              <option value="">All customers</option>
              {(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
        </div>
        <DataTable
          caption="Delivery notes" columns={columns} rows={query.data?.rows} rowKey={(d) => d.id} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()}
          emptyTitle={filtered ? 'No deliveries match' : 'No deliveries yet'} emptyDescription={filtered ? 'Try clearing a filter.' : 'Prepare a delivery from a posted invoice.'}
        />
        <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>
    </>
  )
}
