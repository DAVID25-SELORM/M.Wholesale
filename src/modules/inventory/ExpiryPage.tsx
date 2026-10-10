import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Card, DataTable, PageHeader, Select, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { fmtQty, listExpiringStock, type ExpiringRow } from '@/services/inventory'
import { listWarehouseOptions } from '@/services/warehouses'
import { ExpiryBadge, StockStatusBadge } from './shared'

const WINDOWS = [30, 60, 90, 180, 365] as const

export function ExpiryPage() {
  const [days, setDays] = useState<number>(90)
  const [warehouseId, setWarehouseId] = useState('')
  const warehouses = useQuery({ queryKey: ['warehouse-options', null], queryFn: () => listWarehouseOptions(null), staleTime: 60_000 })
  const query = useQuery({ queryKey: ['expiring', days, warehouseId], queryFn: () => listExpiringStock(days, warehouseId), placeholderData: (prev) => prev })

  const rows = query.data
  const expiredSellable = (rows ?? []).filter((r) => r.days_to_expiry < 0 && r.stock_status === 'AVAILABLE')

  const columns: Column<ExpiringRow>[] = [
    {
      key: 'product', header: 'Product',
      render: (r) => (
        <Link to={`/catalog/products/${r.product_id}`} className="block min-w-0 hover:underline">
          <span className="font-medium text-slate-900">{r.brand_name}</span>
          <span className="block font-mono text-xs text-slate-500">{r.sku}</span>
        </Link>
      ),
    },
    { key: 'batch', header: 'Batch', render: (r) => <span className="font-mono text-xs">{r.batch_number}</span> },
    { key: 'expiry', header: 'Expiry', render: (r) => <span className="flex flex-wrap items-center gap-2"><span className="tabular-nums">{r.expiry_date}</span><ExpiryBadge days={r.days_to_expiry} /></span> },
    { key: 'qty', header: 'Quantity', className: 'text-right', render: (r) => <span className="font-semibold tabular-nums">{fmtQty(r.quantity)}</span> },
    { key: 'status', header: 'Status', hideOnMobile: true, render: (r) => <StockStatusBadge status={r.stock_status} /> },
    { key: 'wh', header: 'Warehouse', hideOnMobile: true, render: (r) => r.warehouse_name },
  ]

  return (
    <>
      <PageHeader title="Expiry" description="Batches that have expired or will expire soon, earliest first. Expired stock can never be sold: move it out with a status change." />
      {expiredSellable.length > 0 && (
        <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <strong>{expiredSellable.length} expired {expiredSellable.length === 1 ? 'batch is' : 'batches are'} still marked Available.</strong>{' '}
          Quarantine or write them off with a status change on the Stock page.
        </div>
      )}
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center">
          <div className="w-full sm:w-56">
            <label htmlFor="expiry-window" className="sr-only">Expiring within</label>
            <Select id="expiry-window" value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
              {WINDOWS.map((d) => <option key={d} value={d}>Expired or within {d} days</option>)}
            </Select>
          </div>
          <div className="w-full sm:w-64">
            <label htmlFor="expiry-warehouse" className="sr-only">Warehouse</label>
            <Select id="expiry-warehouse" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">All my warehouses</option>
              {(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </div>
          {rows && <Badge tone={rows.length ? 'amber' : 'green'} className="sm:ml-auto">{rows.length} {rows.length === 1 ? 'batch' : 'batches'}{rows.length === 1000 ? '+' : ''}</Badge>}
        </div>
        <DataTable
          caption="Expiring stock"
          columns={columns}
          rows={rows}
          rowKey={(r) => `${r.warehouse_id}|${r.location_id ?? ''}|${r.batch_id}|${r.stock_status}`}
          loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null}
          onRetry={() => void query.refetch()}
          emptyTitle="Nothing is close to expiry"
          emptyDescription={`No batch with stock expires within ${days} days.`}
        />
      </Card>
    </>
  )
}
