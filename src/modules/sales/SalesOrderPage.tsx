import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, ErrorState, Field, InlineError, Input, LoadingState, Modal, PageHeader, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { ReasonDialog } from '@/modules/purchasing/shared'
import { useSession } from '@/modules/session/SessionProvider'
import { fmtQty } from '@/services/inventory'
import {
  cancelSalesOrder, closeSalesOrder, getOrderProgress, getSalesOrder, invoiceSalesOrder, listOrderInvoices, listOrderLines, type DocLine, type OrderProgress, type SalesOrder,
} from '@/services/orders'
import { moneyFmt, round2 } from '@/services/sales'
import { SalesDocEditor } from './SalesDocEditor'
import { OrderStatusBadge } from './SalesOrdersPage'
import { SalesStatusBadge } from './SalesInvoicesPage'

export function SalesOrderPage() {
  const { id } = useParams()
  const [sp] = useSearchParams()
  const order = useQuery({ queryKey: ['sales-order', id], queryFn: () => getSalesOrder(id!), enabled: Boolean(id) })
  const lines = useQuery({ queryKey: ['sales-order-lines', id], queryFn: () => listOrderLines(id!), enabled: Boolean(id) })
  if (!id) return <SalesDocEditor kind="order" doc={null} lines={null} presetCustomerId={sp.get('customer') ?? ''} />
  if (order.isPending || lines.isPending) return <LoadingState />
  if (order.isError) return <ErrorState message={toAppError(order.error).message} onRetry={() => void order.refetch()} />
  if (lines.isError) return <ErrorState message={toAppError(lines.error).message} onRetry={() => void lines.refetch()} />
  if (!order.data) return <EmptyState title="Order not found" action={<Link className="text-sm font-medium text-brand-700 hover:underline" to="/sales/orders">Back to orders</Link>} />
  if (order.data.status === 'DRAFT') return <SalesDocEditor key={order.data.updated_at} kind="order" doc={order.data} lines={lines.data} presetCustomerId="" />
  return <OrderView order={order.data} lines={lines.data} />
}

type Ending = 'cancel' | 'close' | null

function OrderView({ order, lines }: { order: SalesOrder; lines: DocLine[] }) {
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const progress = useQuery({ queryKey: ['order-progress', order.id], queryFn: () => getOrderProgress(order.id) })
  const invoices = useQuery({ queryKey: ['order-invoices', order.id], queryFn: () => listOrderInvoices(order.id), enabled: ability.canAnywhere('sales.view') })
  const [ending, setEnding] = useState<Ending>(null)
  const [endError, setEndError] = useState<string | null>(null)
  const [invoicing, setInvoicing] = useState(false)
  const by = (lineId: string): OrderProgress | undefined => (progress.data ?? []).find((p) => p.order_line_id === lineId)
  const refresh = () => Promise.all(['sales-order', 'sales-orders', 'order-progress', 'order-invoices', 'sales-invoices', 'dashboard'].map((k) => qc.invalidateQueries({ queryKey: [k] })))

  const end = useMutation({
    mutationFn: (reason: string) => (ending === 'close' ? closeSalesOrder(order.id, reason) : cancelSalesOrder(order.id, reason)),
    onSuccess: async () => { toast.success(ending === 'close' ? 'Order closed: the rest is no longer reserved.' : 'Order cancelled: the stock is released.'); setEnding(null); await refresh() },
    onError: (e) => setEndError(toAppError(e).message),
  })
  const open = order.status === 'CONFIRMED'
  const anyInvoiced = (progress.data ?? []).some((p) => p.invoiced > 0)
  const remainingTotal = (progress.data ?? []).reduce((s, p) => s + p.remaining, 0)

  return (
    <>
      <Link to="/sales/orders" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" aria-hidden /> Orders</Link>
      <PageHeader
        title={order.order_number ?? 'Order'}
        description={`${order.customer?.name ?? ''}${order.customer_reference ? ` · their PO ${order.customer_reference}` : ''}${order.required_date ? ` · needed by ${order.required_date}` : ''}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <OrderStatusBadge status={order.status} />
            {open && remainingTotal > 0 && ability.can('sales.create', order.branch_id) && <Button onClick={() => setInvoicing(true)}>Create invoice</Button>}
            {open && ability.can('orders.manage', order.branch_id) && (anyInvoiced
              ? <Button variant="secondary" onClick={() => { setEndError(null); setEnding('close') }}>Close short</Button>
              : <Button variant="ghost" onClick={() => { setEndError(null); setEnding('cancel') }}>Cancel order</Button>)}
          </div>
        }
      />
      {open && <p className="mb-4 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-900">{order.reserved_until ? `The remaining stock is held for this customer until ${order.reserved_until}.` : 'The remaining stock is held for this customer until the order is delivered, closed or cancelled.'}</p>}
      {order.status === 'COMPLETED' && <p className="mb-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">Everything ordered has been invoiced.</p>}
      {(order.status === 'CLOSED' || order.status === 'CANCELLED') && order.status_reason && <p className="mb-4 text-sm text-slate-600">{order.status === 'CLOSED' ? 'Closed short' : 'Cancelled'}: {order.status_reason}</p>}

      <Card>
        <CardHeader title="Items" description={order.quotation?.quotation_number ? `From quotation ${order.quotation.quotation_number}. Prices are as agreed.` : 'Prices are as agreed on the order.'} />
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">Ordered items and delivery progress</caption>
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="px-4 py-2">Item</th><th className="pr-3 text-right">Ordered</th><th className="pr-3 text-right">Invoiced</th><th className="pr-3 text-right">On draft invoices</th><th className="pr-3 text-right">Still to invoice</th><th className="pr-3 text-right">Price</th><th className="pr-4 text-right">Amount</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lines.map((l) => {
                  const p = by(l.id)
                  const factor = Number(l.unit?.factor_to_base ?? 1)
                  const unit = factor === 1 ? l.product?.base_unit?.name : l.unit?.unit?.name
                  return (
                    <tr key={l.id}>
                      <td className="px-4 py-2"><span className="font-medium text-slate-900">{l.product?.brand_name}</span> <span className="text-xs text-slate-500">{l.product?.sku}</span></td>
                      <td className="whitespace-nowrap pr-3 text-right tabular-nums">{fmtQty(Number(l.quantity))} {unit}</td>
                      <td className="pr-3 text-right tabular-nums">{p ? fmtQty(p.invoiced) : '…'}</td>
                      <td className="pr-3 text-right tabular-nums text-slate-500">{p && p.in_draft > 0 ? fmtQty(p.in_draft) : ''}</td>
                      <td className="pr-3 text-right tabular-nums font-medium">{p ? (p.remaining > 0 ? fmtQty(p.remaining) : <Badge tone="green">Done</Badge>) : '…'}</td>
                      <td className="pr-3 text-right tabular-nums">{moneyFmt(l.unit_price)}{Number(l.discount_percent) > 0 ? <span className="block text-xs text-slate-500">-{Number(l.discount_percent)}%</span> : null}</td>
                      <td className="pr-4 text-right tabular-nums">{moneyFmt(l.line_total)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <dl className="ml-auto w-full max-w-xs space-y-1 p-4 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">Subtotal</dt><dd className="tabular-nums">{moneyFmt(order.subtotal)}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Tax</dt><dd className="tabular-nums">{moneyFmt(order.tax_total)}</dd></div>
            <div className="flex justify-between border-t border-slate-200 pt-1 text-base font-semibold"><dt>Total</dt><dd className="tabular-nums">{moneyFmt(order.total_amount)}</dd></div>
          </dl>
        </CardBody>
      </Card>

      {(invoices.data ?? []).length > 0 && (
        <div className="mt-5">
          <Card>
            <CardHeader title="Invoices raised from this order" />
            <CardBody>
              <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
                {(invoices.data ?? []).map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="flex items-center gap-2"><Link to={`/sales/invoices/${i.id}`} className="font-mono text-xs font-semibold text-brand-700 hover:underline">{i.invoice_number ?? 'Draft invoice'}</Link><SalesStatusBadge status={i.status} /></span>
                    <span className="tabular-nums">{moneyFmt(i.total_amount)}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
      )}
      {order.confirmed_at && <p className="mt-4 text-xs text-slate-500">Confirmed {formatDateTime(order.confirmed_at)}.</p>}

      {invoicing && (
        <InvoiceDialog
          lines={lines} progress={progress.data ?? []} onClose={() => setInvoicing(false)}
          onCreate={async (chosen) => { const id = await invoiceSalesOrder(order.id, chosen); await refresh(); setInvoicing(false); navigate(`/sales/invoices/${id}`) }}
        />
      )}
      <ReasonDialog
        open={ending !== null} title={ending === 'close' ? `Close ${order.order_number} short` : `Cancel ${order.order_number}`} confirmLabel={ending === 'close' ? 'Close short' : 'Cancel order'} tone="danger"
        description={ending === 'close' ? 'What was never delivered is released: the remaining stock is no longer held for this customer. Delivered goods stay invoiced.' : 'The order is cancelled and its stock is released. Nothing was invoiced, so nothing else changes.'}
        busy={end.isPending} error={endError} onConfirm={(r) => end.mutate(r)} onClose={() => setEnding(null)}
      />
    </>
  )
}

function InvoiceDialog({ lines, progress, onClose, onCreate }: {
  lines: DocLine[]
  progress: OrderProgress[]
  onClose: () => void
  onCreate: (chosen: { order_line_id: string; quantity: number }[]) => Promise<void>
}) {
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(progress.filter((p) => p.remaining > 0).map((p) => [p.order_line_id, String(p.remaining)])))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const chosen: { order_line_id: string; quantity: number }[] = []
    for (const p of progress) {
      const raw = qty[p.order_line_id]
      if (raw === undefined || raw.trim() === '') continue
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0 || Math.abs(round2(n * 1000) / 1000 - n) > 1e-9) { setError('Quantities must be 0 or more with at most 3 decimals.'); return }
      if (n > p.remaining + 1e-9) { setError(`Line ${p.line_no}: only ${fmtQty(p.remaining)} is left to invoice.`); return }
      if (n > 0) chosen.push({ order_line_id: p.order_line_id, quantity: n })
    }
    if (chosen.length === 0) { setError('Enter a quantity on at least one line.'); return }
    setError(null)
    setBusy(true)
    try { await onCreate(chosen) } catch (err) { setError(toAppError(err).message); setBusy(false) }
  }

  return (
    <Modal
      open size="lg" onClose={onClose} title="Create an invoice from this order"
      description="Choose how much to invoice now (a part delivery is fine). The invoice uses the order's prices; you then post it like any invoice."
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Back</Button><Button type="submit" form="order-invoice" loading={busy}>Create draft invoice</Button></>}
    >
      <form id="order-invoice" onSubmit={(e) => void submit(e)} noValidate className="space-y-3">
        <InlineError message={error} />
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
          {lines.map((l) => {
            const p = progress.find((x) => x.order_line_id === l.id)
            if (!p || p.remaining <= 0) return null
            return (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                <span><span className="font-medium text-slate-900">{l.product?.brand_name}</span> <span className="text-xs text-slate-500">{fmtQty(p.remaining)} left of {fmtQty(Number(l.quantity))}</span></span>
                <Field label={`Invoice now (line ${l.line_no})`} className="w-32"><Input type="number" inputMode="decimal" min="0" step="any" value={qty[l.id] ?? ''} onChange={(e) => setQty((s) => ({ ...s, [l.id]: e.target.value }))} /></Field>
              </li>
            )
          })}
        </ul>
      </form>
    </Modal>
  )
}
