import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, ErrorState, LoadingState } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { DOCUMENT_TYPE_LABEL, daysUntil, fmtQty, listProductBalances, listProductMovements } from '@/services/inventory'
import { ExpiryBadge, StockStatusBadge } from './shared'

const MOVEMENT_PAGE = 15

/** Where this product's stock sits (warehouse / location / batch / status) and its ledger history. */
export function ProductStockTab({ productId, baseUnit }: { productId: string; baseUnit: string }) {
  const [page, setPage] = useState(0)
  const balances = useQuery({ queryKey: ['balances', productId, ''], queryFn: () => listProductBalances(productId) })
  const movements = useQuery({
    queryKey: ['movements', productId, page], queryFn: () => listProductMovements(productId, { page, pageSize: MOVEMENT_PAGE }),
    placeholderData: (prev) => prev,
  })
  const total = (balances.data ?? []).filter((b) => b.stock_status === 'AVAILABLE').reduce((s, b) => s + b.quantity, 0)

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Stock on hand" description={`Counted in ${baseUnit.toLowerCase()}s. Earliest expiry first.`} actions={balances.data ? <Badge tone="green">{fmtQty(total)} available</Badge> : null} />
        <CardBody>
          {balances.isPending ? <LoadingState /> : balances.isError ? <ErrorState message={toAppError(balances.error).message} onRetry={() => void balances.refetch()} /> : (balances.data ?? []).length === 0 ? (
            <EmptyState title="No stock" description="Nothing of this product is on hand in the warehouses you can see." />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <caption className="sr-only">Stock on hand by batch</caption>
                <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr><th className="py-2 pr-4">Warehouse</th><th className="pr-4">Batch</th><th className="pr-4">Expiry</th><th className="pr-4">Status</th><th className="text-right">Quantity</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(balances.data ?? []).map((b) => (
                    <tr key={b.id}>
                      <td className="py-2 pr-4">{b.warehouse?.name}{b.location ? <span className="text-slate-500"> · {b.location.code}</span> : null}</td>
                      <td className="pr-4 font-mono text-xs">{b.batch?.batch_number ?? '—'}</td>
                      <td className="pr-4">{b.batch ? <span className="flex flex-wrap items-center gap-2"><span className="tabular-nums">{b.batch.expiry_date}</span><ExpiryBadge days={daysUntil(b.batch.expiry_date)} /></span> : '—'}</td>
                      <td className="pr-4"><StockStatusBadge status={b.stock_status} /></td>
                      <td className="text-right font-semibold tabular-nums">{fmtQty(b.quantity)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Movement history" description="The ledger: every change to this product's stock, newest first." />
        <CardBody>
          {movements.isPending ? <LoadingState /> : movements.isError ? <ErrorState message={toAppError(movements.error).message} onRetry={() => void movements.refetch()} /> : (movements.data?.rows ?? []).length === 0 ? (
            <EmptyState title="No movements yet" />
          ) : (
            <>
              <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
                {(movements.data?.rows ?? []).map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="font-mono text-xs font-semibold">{m.document?.document_number}</span>{' '}
                      <span className="text-slate-600">{m.document ? DOCUMENT_TYPE_LABEL[m.document.document_type] : m.movement_type}</span>
                      <span className="block text-xs text-slate-500">
                        {m.warehouse?.name}{m.location ? ` · ${m.location.code}` : ''}{m.batch ? ` · batch ${m.batch.batch_number}` : ''} · {formatDateTime(m.posted_at)}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <StockStatusBadge status={m.stock_status} />
                      <span className={`w-20 text-right font-semibold tabular-nums ${m.quantity < 0 ? 'text-red-700' : 'text-green-700'}`}>{m.quantity > 0 ? '+' : ''}{fmtQty(m.quantity)}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
                <span>Page {page + 1}</span>
                <span className="flex gap-2">
                  <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
                  <Button size="sm" variant="secondary" disabled={!movements.data?.hasNext} onClick={() => setPage(page + 1)}>Next</Button>
                </span>
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
