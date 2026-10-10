import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, DataTable, PageHeader, Pagination, SearchInput, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { listGoodsReceipts, type GoodsReceipt } from '@/services/purchasing'
import { GoodsReceiptDialog } from './shared'

const PAGE_SIZE = 20

export function GoodsReceiptsPage() {
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<GoodsReceipt | null>(null)
  const params = { page, pageSize: PAGE_SIZE, search, purchaseOrderId: '' }
  const query = useQuery({ queryKey: ['goods-receipts', params], queryFn: () => listGoodsReceipts(params), placeholderData: (prev) => prev })

  const columns: Column<GoodsReceipt>[] = [
    { key: 'grn', header: 'Receipt', render: (r) => <button type="button" className="font-mono text-xs font-semibold text-brand-700 hover:underline" onClick={() => setOpen(r)}>{r.grn_number}</button> },
    { key: 'po', header: 'Order', render: (r) => (r.purchase_order ? <Link className="font-mono text-xs hover:underline" to={`/purchasing/orders/${r.purchase_order_id}`}>{r.purchase_order.po_number}</Link> : '—') },
    { key: 'supplier', header: 'Supplier', render: (r) => r.supplier?.name ?? '—' },
    { key: 'wh', header: 'Warehouse', hideOnMobile: true, render: (r) => r.warehouse?.name ?? '—' },
    { key: 'dn', header: 'Delivery note', hideOnMobile: true, render: (r) => r.delivery_note ?? '—' },
    { key: 'lines', header: 'Lines', hideOnMobile: true, className: 'text-right', render: (r) => <span className="tabular-nums">{r.line_count}</span> },
    { key: 'when', header: 'Received', render: (r) => <span className="whitespace-nowrap text-slate-600">{formatDateTime(r.received_at)}</span> },
  ]

  return (
    <>
      <PageHeader title="Goods received" description="Every delivery posted against a purchase order. Receipts are permanent records; they feed stock the moment they are posted." />
      <Card>
        <div className="border-b border-slate-100 p-4">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(0) }} placeholder="Search by receipt number or delivery note" label="Search receipts" />
        </div>
        <DataTable
          caption="Goods received"
          columns={columns}
          rows={query.data?.rows}
          rowKey={(r) => r.id}
          loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null}
          onRetry={() => void query.refetch()}
          emptyTitle={search ? 'No receipts match' : 'Nothing received yet'}
          emptyDescription={search ? 'Try the receipt number or the supplier’s delivery note.' : 'Open an approved purchase order and use “Receive goods”.'}
        />
        <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>
      <GoodsReceiptDialog receipt={open} onClose={() => setOpen(null)} />
    </>
  )
}
