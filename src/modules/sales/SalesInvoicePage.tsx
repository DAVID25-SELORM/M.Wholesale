import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Printer } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Button, Card, CardBody, CardHeader, EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { useSession } from '@/modules/session/SessionProvider'
import { getCustomer, listCustomerOptions } from '@/services/customers'
import { fmtQty } from '@/services/inventory'
import { getOrganization } from '@/services/organization'
import { RECEIPT_METHOD_LABEL, getSalesInvoice, listInvoicePayments, listSalesAllocations, listSalesLines, moneyFmt, type ReceiptMethod } from '@/services/sales'
import { InvoiceEditor } from './InvoiceEditor'
import { PostInvoiceDialog } from './PostInvoiceDialog'
import { SalesStatusBadge } from './SalesInvoicesPage'

export function SalesInvoicePage() {
  const { id } = useParams()
  const [sp] = useSearchParams()
  const isNew = !id
  const invoice = useQuery({ queryKey: ['sales-invoice', id], queryFn: () => getSalesInvoice(id!), enabled: !isNew })
  const lines = useQuery({ queryKey: ['sales-invoice-lines', id], queryFn: () => listSalesLines(id!), enabled: !isNew })

  if (isNew) return <InvoiceEditor invoice={null} lines={null} presetCustomerId={sp.get('customer') ?? ''} />
  if (invoice.isPending || lines.isPending) return <LoadingState />
  if (invoice.isError) return <ErrorState message={toAppError(invoice.error).message} onRetry={() => void invoice.refetch()} />
  if (lines.isError) return <ErrorState message={toAppError(lines.error).message} onRetry={() => void lines.refetch()} />
  if (!invoice.data) return <EmptyState title="Invoice not found" action={<Link className="text-sm font-medium text-brand-700 hover:underline" to="/sales/invoices">Back to invoices</Link>} />
  if (invoice.data.status === 'DRAFT') return <DraftView key={invoice.data.updated_at} invoiceId={id!} />
  return <PostedView invoiceId={id!} />
}

function DraftView({ invoiceId }: { invoiceId: string }) {
  const { ability } = useSession()
  const invoice = useQuery({ queryKey: ['sales-invoice', invoiceId], queryFn: () => getSalesInvoice(invoiceId) })
  const lines = useQuery({ queryKey: ['sales-invoice-lines', invoiceId], queryFn: () => listSalesLines(invoiceId) })
  const customers = useQuery({ queryKey: ['customer-options'], queryFn: listCustomerOptions, staleTime: 60_000 })
  const [sp, setSp] = useSearchParams()
  const posting = sp.get('post') === '1'
  const inv = invoice.data
  const customer = (customers.data ?? []).find((c) => c.id === inv?.customer_id)
  if (!inv || !lines.data) return <LoadingState />
  // "Save and post" lands here with ?post=1
  return (
    <>
      <InvoiceEditor invoice={inv} lines={lines.data} presetCustomerId="" />
      {posting && customer && ability.can('sales.post', inv.branch_id) && (
        <PostInvoiceDialog invoice={inv} customer={customer} total={Number(inv.total_amount)} branchId={inv.branch_id} onClose={() => setSp({}, { replace: true })} />
      )}
    </>
  )
}

function PostedView({ invoiceId }: { invoiceId: string }) {
  const { ability } = useSession()
  const invoice = useQuery({ queryKey: ['sales-invoice', invoiceId], queryFn: () => getSalesInvoice(invoiceId) })
  const lines = useQuery({ queryKey: ['sales-invoice-lines', invoiceId], queryFn: () => listSalesLines(invoiceId) })
  const allocations = useQuery({ queryKey: ['sales-allocations', invoiceId], queryFn: () => listSalesAllocations(invoiceId) })
  const payments = useQuery({ queryKey: ['invoice-payments', invoiceId], queryFn: () => listInvoicePayments(invoiceId), enabled: ability.canAnywhere('receipts.view') })
  const org = useQuery({ queryKey: ['organization'], queryFn: getOrganization, staleTime: 5 * 60_000 })
  const inv = invoice.data
  const customer = useQuery({ queryKey: ['customer', inv?.customer_id], queryFn: () => getCustomer(inv!.customer_id), enabled: Boolean(inv) })
  if (!inv || !lines.data) return <LoadingState />
  const c = customer.data
  const o = org.data
  const today = new Date().toISOString().slice(0, 10)
  const owed = Number(inv.balance_due)

  return (
    <>
      <div className="print-hidden">
        <Link to="/sales/invoices" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" aria-hidden /> Invoices</Link>
        <PageHeader
          title={inv.invoice_number ?? 'Invoice'}
          description={`${inv.customer?.name ?? ''} · posted ${formatDateTime(inv.posted_at)}`}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <SalesStatusBadge status={inv.status} />
              <Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" aria-hidden /> Print</Button>
            </div>
          }
        />
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
              <p className="text-xl font-bold tracking-wide text-slate-900">{inv.status === 'CANCELLED' ? 'CANCELLED' : 'TAX INVOICE'}</p>
              <p className="font-mono text-sm font-semibold">{inv.invoice_number}</p>
              <p className="text-sm text-slate-600">Date {inv.invoice_date}</p>
              {inv.due_date && <p className="text-sm text-slate-600">Due {inv.due_date}</p>}
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Bill to</p>
              <p className="font-medium text-slate-900">{inv.customer?.name}</p>
              <p className="text-sm text-slate-600">{[c?.address, c?.city, c?.region].filter(Boolean).join(', ')}</p>
              {c?.licence_number && <p className="text-sm text-slate-600">Licence {c.licence_number}</p>}
              {c?.tax_number && <p className="text-sm text-slate-600">Tax no. {c.tax_number}</p>}
            </div>
            <div className="text-sm text-slate-600 sm:text-right">
              {inv.customer_reference && <p>Your reference: {inv.customer_reference}</p>}
              <p>Dispatched from {inv.warehouse?.name}</p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">Invoice lines</caption>
              <thead className="border-b border-slate-300 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="py-2 pr-3">Item</th><th className="pr-3 text-right">Qty</th><th className="pr-3 text-right">Price</th><th className="pr-3 text-right">Disc %</th><th className="pr-3 text-right">Tax</th><th className="text-right">Amount</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lines.data.map((l) => {
                  const picks = (allocations.data ?? []).filter((a) => a.sales_invoice_line_id === l.id)
                  const factor = Number(l.unit?.factor_to_base ?? 1)
                  return (
                    <tr key={l.id} className="align-top">
                      <td className="py-2 pr-3">
                        <span className="font-medium text-slate-900">{l.product?.brand_name}</span> <span className="text-xs text-slate-500">{l.product?.sku}</span>
                        {picks.length > 0 && <span className="block text-xs text-slate-500">{picks.map((a) => `${a.batch?.batch_number ?? '?'} (exp ${a.batch?.expiry_date ?? '?'}) × ${fmtQty(Number(a.base_quantity) / factor)}`).join(' · ')}</span>}
                      </td>
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
            <div className="flex justify-between"><dt className="text-slate-500">Subtotal</dt><dd className="tabular-nums">{moneyFmt(inv.subtotal)}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Tax</dt><dd className="tabular-nums">{moneyFmt(inv.tax_total)}</dd></div>
            <div className="flex justify-between border-t border-slate-200 pt-1 text-base font-semibold"><dt>Total ({inv.currency_code})</dt><dd className="tabular-nums">{moneyFmt(inv.total_amount)}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Paid</dt><dd className="tabular-nums">{moneyFmt(inv.amount_paid)}</dd></div>
            <div className="flex justify-between font-semibold"><dt>Balance due</dt><dd className={`tabular-nums ${owed > 0 && inv.due_date && inv.due_date < today ? 'text-red-700' : ''}`}>{moneyFmt(owed)}</dd></div>
          </dl>
          {inv.notes && <p className="text-sm text-slate-600">{inv.notes}</p>}
        </div>
      </div>

      {(payments.data ?? []).length > 0 && (
        <div className="print-hidden mt-5">
          <Card>
            <CardHeader title="Payments" />
            <CardBody>
              <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
                {(payments.data ?? []).map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span><span className="font-mono text-xs font-semibold">{p.receipt?.receipt_number}</span> <span className="text-slate-500">{RECEIPT_METHOD_LABEL[(p.receipt?.method ?? 'CASH') as ReceiptMethod]} · {p.receipt?.receipt_date}{p.receipt?.reference ? ` · ${p.receipt.reference}` : ''}</span></span>
                    <span className="tabular-nums">{moneyFmt(p.amount)}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
      )}
    </>
  )
}
