import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Button, Field, InlineError, Input, LoadingState, Modal, Select, Textarea, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import type { CustomerOption } from '@/services/customers'
import { RECEIPT_METHODS, RECEIPT_METHOD_LABEL, listOpenInvoices, moneyFmt, recordReceipt, round2, type ReceiptMethod } from '@/services/sales'

export function RecordReceiptDialog({ customers, presetCustomerId, onClose }: { customers: CustomerOption[]; presetCustomerId?: string; onClose: () => void }) {
  const { ability, branches, selectedBranch } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const myBranches = branches.filter((b) => ability.can('receipts.create', b.id))
  const [customerId, setCustomerId] = useState(presetCustomerId ?? '')
  const [branchId, setBranchId] = useState(myBranches.find((b) => b.id === selectedBranch)?.id ?? myBranches[0]?.id ?? '')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<ReceiptMethod>('CASH')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [choose, setChoose] = useState(false)
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const open = useQuery({ queryKey: ['open-invoices', customerId], queryFn: () => listOpenInvoices(customerId), enabled: Boolean(customerId) })
  const owed = (open.data ?? []).reduce((s, i) => s + Number(i.balance_due), 0)
  const amountN = Number(amount)
  const chosenTotal = round2(Object.values(picked).reduce((s, v) => s + (Number(v) || 0), 0))

  const save = useMutation({
    mutationFn: () =>
      recordReceipt({
        customerId, branchId, amount: amountN, method, reference, notes,
        allocations: choose ? Object.entries(picked).filter(([, v]) => Number(v) > 0).map(([invoice_id, v]) => ({ invoice_id, amount: Number(v) })) : null,
      }),
    onSuccess: async (r) => {
      toast.success(`${r.receipt_number} recorded: ${moneyFmt(r.allocated)} applied to invoices${r.unallocated > 0 ? `, ${moneyFmt(r.unallocated)} kept as credit` : ''}.`)
      await Promise.all(['customer-receipts', 'open-invoices', 'customer-credit', 'customer-statement', 'receivables', 'sales-invoices', 'sales-invoice', 'dashboard'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
      onClose()
    },
    onError: (e) => setError(toAppError(e).message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!customerId) { setError('Choose the customer.'); return }
    if (!branchId) { setError('Choose the branch that received the money.'); return }
    if (amount.trim() === '' || !Number.isFinite(amountN) || amountN <= 0 || Math.abs(round2(amountN) - amountN) > 1e-9) { setError('Enter the amount received (more than 0, at most 2 decimals).'); return }
    if (method !== 'CASH' && !reference.trim()) { setError('Enter the reference (cheque number, transfer or mobile money reference).'); return }
    if (choose && chosenTotal > amountN + 1e-9) { setError(`You allocated ${moneyFmt(chosenTotal)}, more than the ${moneyFmt(amountN)} received.`); return }
    setError(null)
    save.mutate()
  }

  return (
    <Modal
      open size="lg" onClose={onClose} title="Record a payment"
      description="Money received from a customer. It pays their oldest invoices first unless you choose; anything left over stays as their credit."
      footer={<><Button variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button><Button type="submit" form="receipt-form" loading={save.isPending}>Record payment</Button></>}
    >
      <form id="receipt-form" onSubmit={submit} noValidate className="space-y-4">
        <InlineError message={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Customer" required>
            <Select value={customerId} disabled={Boolean(presetCustomerId)} onChange={(e) => { setCustomerId(e.target.value); setPicked({}) }}>
              <option value="">Select…</option>
              {customers.filter((c) => c.is_active || c.id === customerId).map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
            </Select>
          </Field>
          <Field label="Received at branch" required>
            <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">Select…</option>
              {myBranches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </Field>
          <Field label="Amount received" required hint={customerId && open.data ? `They owe ${moneyFmt(owed)} on open invoices.` : undefined}>
            <Input type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="How" required>
            <Select value={method} onChange={(e) => setMethod(e.target.value as ReceiptMethod)}>
              {RECEIPT_METHODS.map((m) => <option key={m} value={m}>{RECEIPT_METHOD_LABEL[m]}</option>)}
            </Select>
          </Field>
          <Field label="Reference" required={method !== 'CASH'} className="sm:col-span-2" hint={method === 'CASH' ? 'Optional for cash' : 'Cheque number, transfer reference or mobile money transaction ID'}>
            <Input value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} autoComplete="off" />
          </Field>
        </div>

        {customerId && (
          <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Which invoices does it pay?</legend>
            <label className="flex items-center gap-2 text-sm"><input type="radio" name="alloc" checked={!choose} onChange={() => setChoose(false)} className="h-4 w-4" /> The oldest due first (automatic)</label>
            <label className="flex items-center gap-2 text-sm"><input type="radio" name="alloc" checked={choose} onChange={() => setChoose(true)} className="h-4 w-4" /> I will choose</label>
            {choose && (open.isPending ? <LoadingState /> : (open.data ?? []).length === 0 ? <p className="text-sm text-slate-500">This customer has no open invoices; the payment will be kept as credit.</p> : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <caption className="sr-only">Open invoices</caption>
                  <thead className="text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-1.5 pr-3">Invoice</th><th className="pr-3">Due</th><th className="pr-3 text-right">Owed</th><th className="text-right">Pay</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {(open.data ?? []).map((i) => (
                      <tr key={i.id}>
                        <td className="py-1.5 pr-3 font-mono text-xs">{i.invoice_number}</td>
                        <td className="pr-3">{i.due_date}</td>
                        <td className="pr-3 text-right tabular-nums">{moneyFmt(i.balance_due)}</td>
                        <td className="text-right">
                          <Input aria-label={`Amount to apply to ${i.invoice_number}`} type="number" inputMode="decimal" min="0" max={Number(i.balance_due)} step="0.01" className="ml-auto h-8 w-28 text-right"
                            value={picked[i.id] ?? ''} onChange={(e) => setPicked((p) => ({ ...p, [i.id]: e.target.value }))} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-right text-xs text-slate-500">Applied {moneyFmt(chosenTotal)} of {amount ? moneyFmt(amountN || 0) : '—'}</p>
              </div>
            ))}
          </fieldset>
        )}
        <Field label="Notes"><Textarea rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </form>
    </Modal>
  )
}
