import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useQuery } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Field, InlineError, Input, Modal, Select, Textarea, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import { getCustomerCredit, type CustomerOption } from '@/services/customers'
import { RECEIPT_METHODS, RECEIPT_METHOD_LABEL, moneyFmt, postSalesInvoice, round2, type ReceiptMethod, type SalesInvoice } from '@/services/sales'

/** Final step: posting takes the stock out and puts the amount on the customer's account. */
export function PostInvoiceDialog({ invoice, customer, total, branchId, onClose }: {
  invoice: SalesInvoice
  customer: CustomerOption
  total: number
  branchId: string
  onClose: () => void
}) {
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const canSeeCredit = ability.canAnywhere('receipts.view')
  const credit = useQuery({ queryKey: ['customer-credit', customer.id], queryFn: () => getCustomerCredit(customer.id), enabled: canSeeCredit })
  const canPay = ability.can('receipts.create', branchId)
  const canOverride = ability.can('sales.override_credit', branchId)

  const limit = Number(customer.credit_limit)
  const cashOnly = limit <= 0
  const [payNow, setPayNow] = useState(cashOnly ? String(round2(total)) : '')
  const [method, setMethod] = useState<ReceiptMethod>('CASH')
  const [reference, setReference] = useState('')
  const [override, setOverride] = useState('')
  const [error, setError] = useState<string | null>(null)

  const paid = payNow.trim() === '' ? 0 : Number(payNow)
  const owedAfter = round2(total - (Number.isFinite(paid) ? paid : 0))
  const exposure = (credit.data ? credit.data.outstanding - credit.data.credit_held : 0) + owedAfter
  const overLimit = !cashOnly && credit.data !== undefined && exposure > limit + 1e-9
  const needsOverride = customer.on_hold || overLimit

  const post = useMutation({
    mutationFn: () =>
      postSalesInvoice(invoice.id, override.trim() || undefined, paid > 0 ? { amount: paid, method, reference: reference.trim() || undefined } : undefined),
    onSuccess: async (r) => {
      toast.success(`${r.invoice_number} posted for GHS ${moneyFmt(r.total_amount)}${r.receipt_number ? `; payment ${r.receipt_number} recorded` : ''}.`)
      await Promise.all(['sales-invoices', 'sales-invoice', 'sales-invoice-lines', 'sales-allocations', 'invoice-payments', 'customer-credit', 'customer-statement', 'open-invoices', 'receivables', 'balances', 'dashboard', 'stock-documents']
        .map((k) => qc.invalidateQueries({ queryKey: [k] })))
      onClose()
      navigate(`/sales/invoices/${invoice.id}`, { replace: true })
    },
    onError: (e) => setError(toAppError(e).message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    if (payNow.trim() !== '') {
      if (!Number.isFinite(paid) || paid <= 0 || Math.abs(round2(paid) - paid) > 1e-9) { setError('Enter the payment as an amount above 0 with at most 2 decimals, or leave it empty.'); return }
      if (paid > total + 1e-9) { setError('The payment cannot be more than the invoice total. Record extra money as a separate payment.'); return }
      if (method !== 'CASH' && !reference.trim()) { setError('Enter the payment reference.'); return }
    }
    if (needsOverride && !override.trim()) { setError(canOverride ? 'Give the reason for selling past the credit control.' : 'This customer is on hold or over their credit limit, and you are not allowed to override that.'); return }
    setError(null)
    post.mutate()
  }

  return (
    <Modal
      open size="lg" onClose={onClose} title="Post this invoice"
      description="Posting removes the stock (earliest expiry first), numbers the invoice and adds the amount to the customer’s account. A posted invoice cannot be edited."
      footer={<><Button variant="secondary" onClick={onClose} disabled={post.isPending}>Back</Button><Button type="submit" form="post-form" loading={post.isPending}>Post invoice</Button></>}
    >
      <form id="post-form" onSubmit={submit} noValidate className="space-y-4">
        <InlineError message={error} />
        <dl className="grid grid-cols-2 gap-3 rounded-md bg-slate-50 p-3 text-sm sm:grid-cols-4">
          <div><dt className="text-xs uppercase tracking-wide text-slate-500">Customer</dt><dd className="font-medium">{customer.name}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-slate-500">Total</dt><dd className="font-semibold tabular-nums">{moneyFmt(total)}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-slate-500">Terms</dt><dd>{cashOnly ? 'Cash only' : `${customer.payment_terms_days} days`}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-slate-500">Owed after</dt><dd className="font-medium tabular-nums">{moneyFmt(Math.max(0, owedAfter))}</dd></div>
        </dl>
        {cashOnly && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">This customer has no credit: the payment below must cover the whole invoice.</p>}
        {customer.on_hold && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">On credit hold: {customer.hold_reason}</p>}
        {overLimit && credit.data && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
            This would take the customer to {moneyFmt(exposure)}, over their {moneyFmt(limit)} credit limit.
          </p>
        )}

        {canPay && (
          <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Payment taken now (optional)</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Amount"><Input type="number" inputMode="decimal" min="0" step="0.01" value={payNow} onChange={(e) => setPayNow(e.target.value)} /></Field>
              <Field label="How">
                <Select value={method} onChange={(e) => setMethod(e.target.value as ReceiptMethod)}>
                  {RECEIPT_METHODS.map((m) => <option key={m} value={m}>{RECEIPT_METHOD_LABEL[m]}</option>)}
                </Select>
              </Field>
              <Field label="Reference" required={method !== 'CASH' && payNow.trim() !== ''}><Input value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} /></Field>
            </div>
          </fieldset>
        )}

        {needsOverride && canOverride && (
          <Field label="Reason for overriding the credit control" required hint="Recorded in the audit trail with your name.">
            <Textarea rows={2} maxLength={300} value={override} onChange={(e) => setOverride(e.target.value)} />
          </Field>
        )}
      </form>
    </Modal>
  )
}
