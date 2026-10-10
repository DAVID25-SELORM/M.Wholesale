import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button, Card, CardBody, CardHeader, EmptyState, ErrorState, LoadingState, PageHeader, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { useSession } from '@/modules/session/SessionProvider'
import { fmtQty } from '@/services/inventory'
import {
  approvePurchaseOrder, cancelPurchaseOrder, closePurchaseOrder, getPurchaseOrder, listGoodsReceipts, listPurchaseOrderLines, money,
  rejectPurchaseOrder, remainingPacks, submitPurchaseOrder, type GoodsReceipt,
} from '@/services/purchasing'
import { PurchaseOrderForm } from './PurchaseOrderForm'
import { ReceiveGoodsDialog } from './ReceiveGoodsDialog'
import { GoodsReceiptDialog, PoStatusBadge, ReasonDialog } from './shared'

type Reason = 'reject' | 'cancel' | 'close' | null

export function PurchaseOrderDetailPage() {
  const { id = '' } = useParams()
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [receiving, setReceiving] = useState(false)
  const [reason, setReason] = useState<Reason>(null)
  const [reasonError, setReasonError] = useState<string | null>(null)
  const [openReceipt, setOpenReceipt] = useState<GoodsReceipt | null>(null)

  const order = useQuery({ queryKey: ['purchase-order', id], queryFn: () => getPurchaseOrder(id), enabled: Boolean(id) })
  const lines = useQuery({ queryKey: ['purchase-order-lines', id], queryFn: () => listPurchaseOrderLines(id), enabled: Boolean(id) })
  const receipts = useQuery({
    queryKey: ['goods-receipts', { purchaseOrderId: id }],
    queryFn: () => listGoodsReceipts({ page: 0, pageSize: 50, purchaseOrderId: id, search: '' }),
    enabled: Boolean(id),
  })

  const refresh = () =>
    Promise.all(['purchase-order', 'purchase-order-lines', 'purchase-orders', 'goods-receipts'].map((k) => qc.invalidateQueries({ queryKey: [k] })))

  const simple = useMutation({
    mutationFn: (fn: (id: string) => Promise<void>) => fn(id),
    onSuccess: async () => { toast.success('Done.'); await refresh() },
    onError: (e) => toast.error(toAppError(e).message),
  })
  const withReason = useMutation({
    mutationFn: (v: { kind: Exclude<Reason, null>; text: string }) =>
      ({ reject: rejectPurchaseOrder, cancel: cancelPurchaseOrder, close: closePurchaseOrder })[v.kind](id, v.text),
    onSuccess: async () => { setReason(null); setReasonError(null); toast.success('Done.'); await refresh() },
    onError: (e) => setReasonError(toAppError(e).message),
  })

  if (order.isPending) return <LoadingState />
  if (order.isError) return <ErrorState message={toAppError(order.error).message} onRetry={() => void order.refetch()} />
  const po = order.data
  if (!po) return <EmptyState title="Order not found" description="It may belong to another branch or organization." action={<Link className="text-sm font-medium text-brand-700 hover:underline" to="/purchasing/orders">Back to orders</Link>} />

  const can = (perm: string) => ability.can(perm, po.branch_id)
  const rows = lines.data ?? []
  const canCreate = can('purchasing.create')
  const canApprove = can('purchasing.approve')
  const canReceive = can('purchasing.receive')
  const s = po.status

  const actions = (
    <div className="flex flex-wrap gap-2">
      {s === 'DRAFT' && canCreate && (
        <>
          <Button variant="secondary" onClick={() => setEditing(true)} disabled={!lines.data}>Edit</Button>
          <Button loading={simple.isPending} onClick={() => simple.mutate(submitPurchaseOrder)}>Submit for approval</Button>
          <Button variant="ghost" onClick={() => setReason('cancel')}>Cancel order</Button>
        </>
      )}
      {s === 'SUBMITTED' && canApprove && (
        <>
          <Button loading={simple.isPending} onClick={() => simple.mutate(approvePurchaseOrder)}>Approve</Button>
          <Button variant="secondary" onClick={() => setReason('reject')}>Send back</Button>
          <Button variant="ghost" onClick={() => setReason('cancel')}>Cancel order</Button>
        </>
      )}
      {(s === 'APPROVED' || s === 'PARTIALLY_RECEIVED') && canReceive && <Button onClick={() => setReceiving(true)} disabled={!lines.data}>Receive goods</Button>}
      {s === 'APPROVED' && canApprove && <Button variant="ghost" onClick={() => setReason('cancel')}>Cancel order</Button>}
      {s === 'PARTIALLY_RECEIVED' && canApprove && <Button variant="secondary" onClick={() => setReason('close')}>Close short</Button>}
    </div>
  )

  const reasonText = {
    reject: { title: 'Send back to draft', description: 'The preparer will see your reason and can amend and resubmit.', confirm: 'Send back', tone: 'primary' as const },
    cancel: { title: 'Cancel this order', description: 'The order will no longer be expected. This cannot be undone.', confirm: 'Cancel order', tone: 'danger' as const },
    close: { title: 'Close short', description: 'Stop expecting the rest of this order. Goods already received stay in stock.', confirm: 'Close order', tone: 'danger' as const },
  }

  return (
    <>
      <Link to="/purchasing/orders" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" aria-hidden /> Purchase orders</Link>
      <PageHeader title={po.po_number} description={`${po.supplier?.name ?? ''} · deliver to ${po.warehouse?.name ?? ''}`} actions={actions} />

      <Card>
        <CardBody>
          <div className="mb-3 flex flex-wrap items-center gap-2"><PoStatusBadge status={s} /></div>
          {po.status_reason && (s === 'DRAFT' || s === 'CANCELLED' || s === 'CLOSED') && (
            <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {s === 'DRAFT' ? 'Sent back: ' : s === 'CANCELLED' ? 'Cancelled: ' : 'Closed short: '}{po.status_reason}
            </p>
          )}
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
            {([
              ['Order date', po.order_date],
              ['Expected', po.expected_date ?? '—'],
              ['Payment terms', `${po.payment_terms_days} days`],
              ['Total (before tax)', money(po.total_amount, po.currency_code)],
              ['Created', formatDateTime(po.created_at)],
              ['Submitted', po.submitted_at ? formatDateTime(po.submitted_at) : '—'],
              ['Approved', po.approved_at ? formatDateTime(po.approved_at) : '—'],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k}><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{k}</dt><dd className="mt-0.5 text-sm text-slate-900">{v}</dd></div>
            ))}
          </dl>
          {po.notes && <p className="mt-4 text-sm text-slate-600">{po.notes}</p>}
        </CardBody>
      </Card>

      <div className="mt-5">
        <Card>
          <CardHeader title="Lines" description="Ordered, received and still expected, in the pack level each line was ordered in." />
          <CardBody>
            {lines.isPending ? <LoadingState /> : lines.isError ? <ErrorState message={toAppError(lines.error).message} onRetry={() => void lines.refetch()} /> : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <caption className="sr-only">Order lines</caption>
                  <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr><th className="py-2 pr-4">Product</th><th className="pr-4 text-right">Ordered</th><th className="pr-4 text-right">Received</th><th className="pr-4 text-right">Expected</th><th className="pr-4 text-right">Cost</th><th className="text-right">Total</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((l) => {
                      const left = remainingPacks(l)
                      const received = Number(l.quantity_ordered) - left
                      const unit = l.unit?.unit?.name?.toLowerCase() ?? ''
                      return (
                        <tr key={l.id}>
                          <td className="py-2 pr-4"><span className="font-medium text-slate-900">{l.product?.brand_name}</span> <span className="font-mono text-xs text-slate-500">{l.product?.sku}</span></td>
                          <td className="pr-4 text-right tabular-nums">{fmtQty(Number(l.quantity_ordered))} {unit}</td>
                          <td className="pr-4 text-right tabular-nums">{fmtQty(received)}</td>
                          <td className={`pr-4 text-right tabular-nums ${left > 0 && (s === 'APPROVED' || s === 'PARTIALLY_RECEIVED') ? 'font-semibold text-amber-700' : 'text-slate-500'}`}>{fmtQty(left)}</td>
                          <td className="pr-4 text-right tabular-nums">{Number(l.unit_cost).toFixed(2)}</td>
                          <td className="text-right tabular-nums font-medium">{Number(l.line_total).toFixed(2)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-5">
        <Card>
          <CardHeader title="Goods received" description="Every delivery posted against this order. Receipts cannot be edited." />
          <CardBody>
            {receipts.isPending ? <LoadingState /> : receipts.isError ? <ErrorState message={toAppError(receipts.error).message} onRetry={() => void receipts.refetch()} /> : (receipts.data?.rows ?? []).length === 0 ? (
              <EmptyState title="Nothing received yet" description={s === 'APPROVED' ? 'Use “Receive goods” when the delivery arrives.' : undefined} />
            ) : (
              <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
                {(receipts.data?.rows ?? []).map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                    <button type="button" className="font-mono text-xs font-semibold text-brand-700 hover:underline" onClick={() => setOpenReceipt(r)}>{r.grn_number}</button>
                    <span className="text-slate-600">{formatDateTime(r.received_at)}{r.delivery_note ? ` · DN ${r.delivery_note}` : ''} · {r.line_count} {r.line_count === 1 ? 'line' : 'lines'}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <PurchaseOrderForm open={editing} order={po} lines={lines.data ?? null} onClose={() => setEditing(false)} onSaved={() => undefined} />
      <ReceiveGoodsDialog order={receiving ? po : null} lines={rows} onClose={() => setReceiving(false)} />
      <GoodsReceiptDialog receipt={openReceipt} onClose={() => setOpenReceipt(null)} />
      {reason && (
        <ReasonDialog
          open title={reasonText[reason].title} description={reasonText[reason].description} confirmLabel={reasonText[reason].confirm}
          tone={reasonText[reason].tone} busy={withReason.isPending} error={reasonError}
          onConfirm={(text) => withReason.mutate({ kind: reason, text })}
          onClose={() => { setReason(null); setReasonError(null) }}
        />
      )}
    </>
  )
}
