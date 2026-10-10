import { useQuery } from '@tanstack/react-query'
import { ArrowRightLeft, ClipboardEdit, PackagePlus, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, DataTable, PageHeader, Pagination, SearchInput, Select, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import {
  DOCUMENT_PERMISSION, DOCUMENT_TYPES, DOCUMENT_TYPE_LABEL, NEAR_EXPIRY_DAYS, daysUntil, fmtQty, listStockSummary,
  type DocumentType, type StockSummaryRow,
} from '@/services/inventory'
import { listWarehouseOptions } from '@/services/warehouses'
import { ExpiryBadge } from './shared'
import { StockPostingDialog } from './StockPostingDialog'

const PAGE_SIZE = 20
const ICON: Record<DocumentType, typeof PackagePlus> = {
  OPENING: PackagePlus, ADJUSTMENT: ClipboardEdit, TRANSFER: ArrowRightLeft, STATUS_CHANGE: ShieldAlert,
}

export function StockPage() {
  const { ability } = useSession()
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [posting, setPosting] = useState<DocumentType | null>(null)

  const warehouses = useQuery({ queryKey: ['warehouse-options', null], queryFn: () => listWarehouseOptions(null), staleTime: 60_000 })
  const params = { page, pageSize: PAGE_SIZE, search, warehouseId }
  const query = useQuery({ queryKey: ['stock', 'summary', params], queryFn: () => listStockSummary(params), placeholderData: (prev) => prev })

  const columns: Column<StockSummaryRow>[] = [
    { key: 'sku', header: 'SKU', render: (r) => <span className="font-mono text-xs font-semibold">{r.sku}</span> },
    {
      key: 'name', header: 'Product',
      render: (r) => (
        <Link to={`/catalog/products/${r.product_id}`} className="block min-w-0 hover:underline">
          <span className="font-medium text-slate-900">{r.brand_name}</span>
          <span className="block truncate text-xs text-slate-500">{[r.generic_name, r.strength_text].filter(Boolean).join(' · ')}</span>
        </Link>
      ),
    },
    { key: 'available', header: 'Available', className: 'text-right', render: (r) => <span className="font-semibold tabular-nums">{fmtQty(r.available)}</span> },
    {
      key: 'held', header: 'On hold', hideOnMobile: true, className: 'text-right',
      render: (r) => {
        const held = r.quarantine + r.damaged + r.expired_status
        return held > 0 ? <span className="tabular-nums text-amber-700">{fmtQty(held)}</span> : <span className="text-slate-400">—</span>
      },
    },
    {
      key: 'expiry', header: 'Expiry', hideOnMobile: true,
      render: (r) => (
        <span className="flex flex-wrap items-center gap-1">
          {r.expired_unsold > 0 && <Badge tone="red">{fmtQty(r.expired_unsold)} expired, unsold</Badge>}
          {r.near_expiry > 0 && <Badge tone="amber">{fmtQty(r.near_expiry)} within {NEAR_EXPIRY_DAYS} d</Badge>}
          {r.earliest_expiry && r.expired_unsold === 0 && r.near_expiry === 0 && <ExpiryBadge days={daysUntil(r.earliest_expiry)} />}
        </span>
      ),
    },
    { key: 'unit', header: 'Unit', hideOnMobile: true, render: (r) => <span className="text-slate-500">{r.base_unit.toLowerCase()}</span> },
  ]

  const canPost = DOCUMENT_TYPES.filter((t) => ability.canAnywhere(DOCUMENT_PERMISSION[t]))

  return (
    <>
      <PageHeader
        title="Stock"
        description="Quantities on hand by product, counted in each product's base unit. Only Available stock can be sold."
        actions={
          canPost.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {canPost.map((t) => {
                const Icon = ICON[t]
                return <Button key={t} variant={t === 'OPENING' ? 'primary' : 'secondary'} onClick={() => setPosting(t)}><Icon className="h-4 w-4" aria-hidden /> {DOCUMENT_TYPE_LABEL[t]}</Button>
              })}
            </div>
          )
        }
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center">
          <div className="flex-1"><SearchInput value={search} onChange={(v) => { setSearch(v); setPage(0) }} placeholder="Search stock — name, SKU, barcode or alias" label="Search stock" /></div>
          <div className="w-full lg:w-64">
            <label htmlFor="stock-warehouse" className="sr-only">Warehouse</label>
            <Select id="stock-warehouse" value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setPage(0) }}>
              <option value="">All my warehouses</option>
              {(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </div>
        </div>
        <DataTable
          caption="Stock on hand"
          columns={columns}
          rows={query.data?.rows}
          rowKey={(r) => r.product_id}
          loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null}
          onRetry={() => void query.refetch()}
          emptyTitle={search || warehouseId ? 'No stock matches' : 'No stock recorded yet'}
          emptyDescription={search || warehouseId ? 'Try another warehouse or fewer words.' : 'Load your starting quantities with “Opening stock”, by batch and expiry.'}
        />
        <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>
      <StockPostingDialog type={posting} onClose={() => setPosting(null)} />
    </>
  )
}
