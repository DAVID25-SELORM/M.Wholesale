import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Printer } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Button, EmptyState, ErrorState, LoadingState, PageHeader, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { ReasonDialog } from '@/modules/purchasing/shared'
import { useSession } from '@/modules/session/SessionProvider'
import { getCustomer } from '@/services/customers'
import { fmtQty } from '@/services/inventory'
import { cancelQuotation, convertQuotation, getQuotation, listQuotationLines, rejectQuotation, type DocLine, type Quotation } from '@/services/orders'
import { getOrganization } from '@/services/organization'
import { moneyFmt } from '@/services/sales'
import { QuotationStatusBadge, isExpired } from './QuotationsPage'
import { SalesDocEditor } from './SalesDocEditor'

export function QuotationPage() {
  const { id } = useParams()
  const [sp] = useSearchParams()
  const quote = useQuery({ queryKey: ['quotation', id], queryFn: () => getQuotation(id!), enabled: Boolean(id) })
  const lines = useQuery({ queryKey: ['quotation-lines', id], queryFn: () => listQuotationLines(id!), enabled: Boolean(id) })
  if (!id) return <SalesDocEditor kind="quotation" doc={null} lines={null} presetCustomerId={sp.get('customer') ?? ''} />
  if (quote.isPending || lines.isPending) return <LoadingState />
  if (quote.isError) return <ErrorState message={toAppError(quote.error).message} onRetry={() => void quote.refetch()} />
  if (lines.isError) return <ErrorState message={toAppError(lines.error).message} onRetry={() => void lines.refetch()} />
  if (!quote.data) return <EmptyState title="Quotation not found" action={<Link className="text-sm font-medium text-brand-700 hover:underline" to="/sales/quotations">Back to quotations</Link>} />
  if (quote.data.status === 'DRAFT') return <SalesDocEditor key={quote.data.updated_at} kind="quotation" doc={quote.data} lines={lines.data} presetCustomerId="" />
  return <QuotationView quote={quote.data} lines={lines.data} />
}

type Closing = 'reject' | 'cancel' | null

function QuotationView({ quote, lines }: { quote: Quotation; lines: DocLine[] }) {
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const [closing, setClosing] = useState<Closing>(null)
  const [closeError, setCloseError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const org = useQuery({ queryKey: ['organization'], queryFn: getOrganization, staleTime: 5 * 60_000 })
  const customer = useQuery({ queryKey: ['customer', quote.customer_id], queryFn: () => getCustomer(quote.customer_id) })
  const o = org.data
  const c = customer.data
  const expired = isExpired(quote)
  const refresh = () => Promise.all(['quotation', 'quotations', 'sales-orders', 'dashboard'].map((k) => qc.invalidateQueries({ queryKey: [k] })))

  const accept = useMutation({
    mutationFn: () => convertQuotation(quote.id),
    onSuccess: async (orderId) => { toast.success('Accepted: a draft order was created with the quoted prices.'); await refresh(); navigate(`/sales/orders/${orderId}`) },
    onError: (e) => setError(toAppError(e).message),
  })
  const close = useMutation({
    mutationFn: (reason: string) => (closing === 'reject' ? rejectQuotation(quote.id, reason) : cancelQuotation(quote.id, reason)),
    onSuccess: async () => { toast.success(closing === 'reject' ? 'Marked as rejected.' : 'Quotation cancelled.'); setClosing(null); await refresh() },
    onError: (e) => setCloseError(toAppError(e).message),
  })
  const canAct = ability.can('quotations.create', quote.branch_id)

  return (
    <>
      <div className="print-hidden">
        <Link to="/sales/quotations" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" aria-hidden /> Quotations</Link>
        <PageHeader
          title={quote.quotation_number ?? 'Quotation'}
          description={`${quote.customer?.name ?? ''} · valid until ${quote.valid_until}`}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <QuotationStatusBadge q={quote} />
              {quote.status === 'SENT' && canAct && !expired && ability.can('orders.create', quote.branch_id) && <Button onClick={() => { setError(null); accept.mutate() }} loading={accept.isPending}>Accepted: make an order</Button>}
              {quote.status === 'SENT' && canAct && <Button variant="secondary" onClick={() => { setCloseError(null); setClosing('reject') }}>Rejected</Button>}
              {quote.status === 'SENT' && canAct && <Button variant="ghost" onClick={() => { setCloseError(null); setClosing('cancel') }}>Cancel</Button>}
              <Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" aria-hidden /> Print</Button>
            </div>
          }
        />
        {error && <p role="alert" className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        {expired && <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">This quotation expired on {quote.valid_until} and can no longer be accepted. Make a new one if the customer still wants it.</p>}
        {quote.status === 'ACCEPTED' && quote.converted_order_id && <p className="mb-3 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">Accepted. <Link className="font-medium underline" to={`/sales/orders/${quote.converted_order_id}`}>Open the order {quote.order?.order_number ?? ''}</Link></p>}
        {(quote.status === 'REJECTED' || quote.status === 'CANCELLED') && quote.status_reason && <p className="mb-3 text-sm text-slate-600">{quote.status === 'REJECTED' ? 'Rejected' : 'Cancelled'}: {quote.status_reason}</p>}
      </div>

      <div id="print-area" className="rounded-xl border border-slate-200 bg-white">
        <div className="space-y-5 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-lg font-semibold text-slate-900">{o?.legal_name || o?.name || ''}</p>
              <p className="text-sm text-slate-600">{[o?.address, o?.city, o?.region].filter(Boolean).join(', ')}</p>
              <p className="text-sm text-slate-600">{[o?.phone, o?.email].filter(Boolean).join(' · ')}</p>
              {o?.tax_number && <p className="text-sm text-slate-600">Tax no. {o.tax_number}</p>}
            </div>
            <div className="text-right">
              <p className="text-xl font-bold tracking-wide text-slate-900">QUOTATION</p>
              <p className="font-mono text-sm font-semibold">{quote.quotation_number}</p>
              <p className="text-sm text-slate-600">Date {quote.quotation_date}</p>
              <p className="text-sm font-medium text-slate-800">Valid until {quote.valid_until}</p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Prepared for</p>
              <p className="font-medium text-slate-900">{quote.customer?.name}</p>
              <p className="text-sm text-slate-600">{[c?.address, c?.city, c?.region].filter(Boolean).join(', ')}</p>
            </div>
            <div className="text-sm text-slate-600 sm:text-right">{quote.customer_reference && <p>Your reference: {quote.customer_reference}</p>}{c && <p>Payment terms: {c.payment_terms_days > 0 ? `${c.payment_terms_days} days` : 'cash'}</p>}</div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">Quoted items</caption>
              <thead className="border-b border-slate-300 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="py-2 pr-3">Item</th><th className="pr-3 text-right">Qty</th><th className="pr-3 text-right">Price</th><th className="pr-3 text-right">Disc %</th><th className="pr-3 text-right">Tax</th><th className="text-right">Amount</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lines.map((l) => {
                  const factor = Number(l.unit?.factor_to_base ?? 1)
                  return (
                    <tr key={l.id}>
                      <td className="py-2 pr-3"><span className="font-medium text-slate-900">{l.product?.brand_name}</span> <span className="text-xs text-slate-500">{l.product?.sku}</span></td>
                      <td className="whitespace-nowrap pr-3 text-right tabular-nums">{fmtQty(Number(l.quantity))} {factor === 1 ? l.product?.base_unit?.name : l.unit?.unit?.name}</td>
                      <td className="pr-3 text-right tabular-nums">{moneyFmt(l.unit_price)}</td>
                      <td className="pr-3 text-right tabular-nums">{Number(l.discount_percent) > 0 ? Number(l.discount_percent) : ''}</td>
                      <td className="pr-3 text-right tabular-nums">{Number(l.tax_rate) > 0 ? `${Number(l.tax_rate)}%` : 'Exempt'}</td>
                      <td className="text-right font-medium tabular-nums">{moneyFmt(l.line_total)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <dl className="ml-auto w-full max-w-xs space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">Subtotal</dt><dd className="tabular-nums">{moneyFmt(quote.subtotal)}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Tax</dt><dd className="tabular-nums">{moneyFmt(quote.tax_total)}</dd></div>
            <div className="flex justify-between border-t border-slate-200 pt-1 text-base font-semibold"><dt>Total ({quote.currency_code})</dt><dd className="tabular-nums">{moneyFmt(quote.total_amount)}</dd></div>
          </dl>
          {quote.notes && <p className="whitespace-pre-line text-sm text-slate-600">{quote.notes}</p>}
          <p className="text-xs text-slate-500">Prices are for the quantities shown and subject to stock on acceptance. Sent {quote.sent_at ? formatDateTime(quote.sent_at) : ''}.</p>
        </div>
      </div>

      <ReasonDialog
        open={closing !== null} title={closing === 'reject' ? `Mark ${quote.quotation_number} as rejected` : `Cancel ${quote.quotation_number}`} confirmLabel={closing === 'reject' ? 'Mark as rejected' : 'Cancel quotation'} tone="danger"
        description={closing === 'reject' ? 'The customer declined the offer. Record why (price, stock, went elsewhere ...).' : 'The offer is withdrawn.'}
        busy={close.isPending} error={closeError} onConfirm={(r) => close.mutate(r)} onClose={() => setClosing(null)}
      />
    </>
  )
}
