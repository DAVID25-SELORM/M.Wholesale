import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, DataTable, PageHeader, Select, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import { fmtQty, listStockValuation, type ValuationRow } from '@/services/inventory'
import { listWarehouseOptions } from '@/services/warehouses'

const csvCell = (v: string | number) => {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function ValuationPage() {
  const { context } = useSession()
  const currency = context.organization?.currency_code ?? ''
  const [warehouseId, setWarehouseId] = useState('')
  const warehouses = useQuery({ queryKey: ['warehouse-options', null], queryFn: () => listWarehouseOptions(null), staleTime: 60_000 })
  const query = useQuery({ queryKey: ['stock-valuation', warehouseId], queryFn: () => listStockValuation(warehouseId), placeholderData: (prev) => prev })

  const rows = query.data
  const total = (rows ?? []).reduce((s, r) => s + r.value, 0)
  const uncosted = (rows ?? []).filter((r) => r.uncosted_quantity > 0)
  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  function exportCsv() {
    const header = ['SKU', 'Product', 'Unit', 'Good quantity', 'Damaged/expired quantity', 'Uncosted quantity', `Value ${currency}`]
    const lines = (rows ?? []).map((r) => [r.sku, r.brand_name, r.base_unit, r.good_quantity, r.other_quantity, r.uncosted_quantity, r.value.toFixed(2)])
    const csv = [header, ...lines].map((l) => l.map(csvCell).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `stock-valuation-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const columns: Column<ValuationRow>[] = [
    { key: 'sku', header: 'SKU', render: (r) => <span className="font-mono text-xs font-semibold">{r.sku}</span> },
    { key: 'name', header: 'Product', render: (r) => <Link to={`/catalog/products/${r.product_id}`} className="font-medium text-slate-900 hover:underline">{r.brand_name}</Link> },
    { key: 'qty', header: 'Good stock', className: 'text-right', render: (r) => <span className="tabular-nums">{fmtQty(r.good_quantity)} <span className="text-xs text-slate-500">{r.base_unit.toLowerCase()}</span></span> },
    { key: 'other', header: 'Damaged / expired', hideOnMobile: true, className: 'text-right', render: (r) => (r.other_quantity > 0 ? <span className="tabular-nums text-slate-500">{fmtQty(r.other_quantity)}</span> : '—') },
    { key: 'unc', header: 'No cost on record', hideOnMobile: true, className: 'text-right', render: (r) => (r.uncosted_quantity > 0 ? <Badge tone="amber">{fmtQty(r.uncosted_quantity)}</Badge> : '—') },
    { key: 'val', header: `Value ${currency}`, className: 'text-right', render: (r) => <span className="font-semibold tabular-nums">{fmt(r.value)}</span> },
  ]

  return (
    <>
      <PageHeader
        title="Stock valuation"
        description="Good stock (available and quarantined) at what each batch cost. Damaged and expired stock carries no value."
        actions={<Button variant="secondary" onClick={exportCsv} disabled={!rows || rows.length === 0}><Download className="h-4 w-4" aria-hidden /> Export CSV</Button>}
      />
      {uncosted.length > 0 && (
        <div role="note" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>{uncosted.length} {uncosted.length === 1 ? 'product has' : 'products have'} stock with no cost on record</strong> and {uncosted.length === 1 ? 'is' : 'are'} valued at zero here.
          Enter the cost when loading opening stock, and receive goods against purchase orders, so every batch is costed.
        </div>
      )}
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center">
          <div className="w-full sm:w-64">
            <label htmlFor="val-warehouse" className="sr-only">Warehouse</label>
            <Select id="val-warehouse" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">All my warehouses</option>
              {(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </div>
          {rows && <p className="text-sm text-slate-600 sm:ml-auto">Total stock value <strong className="text-base text-slate-900 tabular-nums">{currency} {fmt(total)}</strong></p>}
        </div>
        <DataTable
          caption="Stock valuation"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.product_id}
          loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null}
          onRetry={() => void query.refetch()}
          emptyTitle="No stock to value"
          emptyDescription="Load opening stock or receive goods first."
        />
      </Card>
    </>
  )
}
