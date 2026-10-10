import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, LoadingState, Modal, PageHeader, Pagination, Select, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import {
  DOCUMENT_TYPES, DOCUMENT_TYPE_LABEL, REASON_LABEL, fmtQty, listDocumentMovements, listStockDocuments,
  type DocumentType, type StockDocumentRow,
} from '@/services/inventory'
import { listWarehouseOptions } from '@/services/warehouses'
import { StockStatusBadge } from './shared'

const PAGE_SIZE = 20

export function StockDocumentsPage() {
  const [page, setPage] = useState(0)
  const [type, setType] = useState<DocumentType | ''>('')
  const [warehouseId, setWarehouseId] = useState('')
  const [open, setOpen] = useState<StockDocumentRow | null>(null)
  const warehouses = useQuery({ queryKey: ['warehouse-options', null], queryFn: () => listWarehouseOptions(null), staleTime: 60_000 })
  const params = { page, pageSize: PAGE_SIZE, type, warehouseId }
  const query = useQuery({ queryKey: ['stock-documents', params], queryFn: () => listStockDocuments(params), placeholderData: (prev) => prev })

  const columns: Column<StockDocumentRow>[] = [
    { key: 'no', header: 'Document', render: (d) => <button type="button" className="font-mono text-xs font-semibold text-brand-700 hover:underline" onClick={() => setOpen(d)}>{d.document_number}</button> },
    { key: 'type', header: 'Type', render: (d) => <Badge tone={d.document_type === 'OPENING' ? 'blue' : d.document_type === 'TRANSFER' ? 'purple' : 'slate'}>{DOCUMENT_TYPE_LABEL[d.document_type]}</Badge> },
    { key: 'wh', header: 'Warehouse', render: (d) => (d.to_warehouse ? `${d.warehouse?.name ?? '?'} → ${d.to_warehouse.name}` : (d.warehouse?.name ?? '—')) },
    { key: 'reason', header: 'Reason', hideOnMobile: true, render: (d) => (d.reason_code ? (REASON_LABEL[d.reason_code] ?? d.reason_code) : '—') },
    { key: 'lines', header: 'Lines', hideOnMobile: true, className: 'text-right', render: (d) => <span className="tabular-nums">{d.line_count}</span> },
    { key: 'when', header: 'Posted', render: (d) => <span className="whitespace-nowrap text-slate-600">{formatDateTime(d.posted_at)}</span> },
  ]

  return (
    <>
      <PageHeader title="Stock documents" description="Every opening balance, adjustment, transfer and status change. Documents cannot be edited or deleted: a mistake is corrected by posting a new one." />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row">
          <div className="w-full sm:w-56">
            <label htmlFor="doc-type" className="sr-only">Type</label>
            <Select id="doc-type" value={type} onChange={(e) => { setType(e.target.value as DocumentType | ''); setPage(0) }}>
              <option value="">All types</option>
              {DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{DOCUMENT_TYPE_LABEL[t]}</option>)}
            </Select>
          </div>
          <div className="w-full sm:w-64">
            <label htmlFor="doc-warehouse" className="sr-only">Warehouse</label>
            <Select id="doc-warehouse" value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setPage(0) }}>
              <option value="">All my warehouses</option>
              {(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </div>
        </div>
        <DataTable
          caption="Stock documents"
          columns={columns}
          rows={query.data?.rows}
          rowKey={(d) => d.id}
          loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null}
          onRetry={() => void query.refetch()}
          emptyTitle="No stock documents yet"
          emptyDescription="They appear here as soon as you load opening stock or post an adjustment, transfer or status change."
        />
        <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>
      <DocumentDialog doc={open} onClose={() => setOpen(null)} />
    </>
  )
}

function DocumentDialog({ doc, onClose }: { doc: StockDocumentRow | null; onClose: () => void }) {
  const lines = useQuery({ queryKey: ['movements', 'document', doc?.id], queryFn: () => listDocumentMovements(doc!.id), enabled: Boolean(doc) })
  if (!doc) return null
  return (
    <Modal
      open size="lg" onClose={onClose}
      title={`${DOCUMENT_TYPE_LABEL[doc.document_type]} ${doc.document_number}`}
      description={`${formatDateTime(doc.posted_at)}${doc.reason_code ? ` · ${REASON_LABEL[doc.reason_code] ?? doc.reason_code}` : ''}`}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      {doc.notes && <p className="mb-3 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">{doc.notes}</p>}
      {lines.isPending ? <LoadingState /> : lines.isError ? <ErrorState message={toAppError(lines.error).message} onRetry={() => void lines.refetch()} /> : (lines.data ?? []).length === 0 ? (
        <EmptyState title="No lines visible" description="You may not have access to the warehouses involved." />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <caption className="sr-only">Ledger lines</caption>
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr><th className="py-2 pr-3">Product</th><th className="pr-3">Batch</th><th className="pr-3">Warehouse</th><th className="pr-3">Status</th><th className="text-right">Qty</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(lines.data ?? []).map((m) => (
                <tr key={m.id}>
                  <td className="py-2 pr-3"><span className="font-medium">{m.product?.brand_name}</span> <span className="font-mono text-xs text-slate-500">{m.product?.sku}</span></td>
                  <td className="pr-3 font-mono text-xs">{m.batch ? `${m.batch.batch_number} · ${m.batch.expiry_date}` : '—'}</td>
                  <td className="pr-3">{m.warehouse?.name}{m.location ? ` · ${m.location.code}` : ''}</td>
                  <td className="pr-3"><StockStatusBadge status={m.stock_status} /></td>
                  <td className={`text-right font-semibold tabular-nums ${m.quantity < 0 ? 'text-red-700' : 'text-green-700'}`}>{m.quantity > 0 ? '+' : ''}{fmtQty(m.quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}
