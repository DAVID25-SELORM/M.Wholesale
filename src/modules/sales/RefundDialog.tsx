import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Button, Field, InlineError, Input, Modal, Select, Textarea, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { useAuth } from '@/modules/auth/AuthProvider'
import { getMyOpenSession } from '@/services/pos'
import { refundCustomer, type RefundSource } from '@/services/refunds'
import { RECEIPT_METHODS, RECEIPT_METHOD_LABEL, moneyFmt, round2, type ReceiptMethod } from '@/services/sales'

export interface RefundSourceInfo {
  type: RefundSource
  id: string
  /** e.g. "CRN-2026-000001" */
  label: string
  customerName: string
  unused: number
  branchId: string
}

/** Pays unused customer credit back: how, how much, and (for cash) optionally out of your own open till shift. */
export function RefundDialog({ source, onClose }: { source: RefundSourceInfo; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const { auth } = useAuth()
  const userId = auth.status === 'signedIn' ? auth.session.user.id : ''
  const session = useQuery({ queryKey: ['pos-session', userId], queryFn: () => getMyOpenSession(userId), enabled: Boolean(userId) })
  const [amount, setAmount] = useState(String(source.unused))
  const [method, setMethod] = useState<ReceiptMethod>('CASH')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [fromTill, setFromTill] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const till = session.data && session.data.branch_id === source.branchId ? session.data : null

  const refund = useMutation({
    mutationFn: () => refundCustomer({
      sourceType: source.type, sourceId: source.id, amount: Number(amount), method, reference, notes,
      posSessionId: method === 'CASH' && fromTill && till ? till.id : null,
    }),
    onSuccess: async (r) => {
      toast.success(`${r.refund_number}: ${moneyFmt(r.amount)} paid back to ${source.customerName}.`)
      await Promise.all(['unused-credit', 'unallocated-receipts', 'customer-credit', 'customer-statement', 'customer-receipts', 'credit-notes', 'credit-note', 'refunds', 'receivables', 'pos-summary', 'dashboard']
        .map((k) => qc.invalidateQueries({ queryKey: [k] })))
      onClose()
    },
    onError: (e) => setError(toAppError(e).message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    const n = Number(amount)
    if (amount.trim() === '' || !Number.isFinite(n) || n <= 0 || Math.abs(round2(n) - n) > 1e-9) { setError('Enter the amount to pay back (above 0, at most 2 decimals).'); return }
    if (n > source.unused + 1e-9) { setError(`Only ${moneyFmt(source.unused)} of this credit is unused.`); return }
    if (method !== 'CASH' && !reference.trim()) { setError('Enter the reference of the payment (transaction, cheque or transfer number).'); return }
    setError(null)
    refund.mutate()
  }

  return (
    <Modal
      open size="md" onClose={onClose} title={`Pay back ${source.customerName}`}
      description={`From ${source.label}: ${moneyFmt(source.unused)} unused. The money leaves the business; the customer's credit goes down by the same amount.`}
      footer={<><Button variant="secondary" onClick={onClose} disabled={refund.isPending}>Back</Button><Button type="submit" form="refund-form" loading={refund.isPending}>Record refund</Button></>}
    >
      <form id="refund-form" onSubmit={submit} noValidate className="space-y-3">
        <InlineError message={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount" required><Input type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></Field>
          <Field label="Paid back by" required>
            <Select value={method} onChange={(e) => { setMethod(e.target.value as ReceiptMethod); if (e.target.value !== 'CASH') setFromTill(false) }}>
              {RECEIPT_METHODS.map((m) => <option key={m} value={m}>{RECEIPT_METHOD_LABEL[m]}</option>)}
            </Select>
          </Field>
        </div>
        {method !== 'CASH' && <Field label="Reference" required hint="Transaction ID, cheque or transfer number"><Input value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} /></Field>}
        {method === 'CASH' && till && (
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={fromTill} onChange={(e) => setFromTill(e.target.checked)} />
            <span>Pay this cash out of my open till shift ({till.session_number}), so the drawer is expected to hold that much less.</span>
          </label>
        )}
        <Field label="Notes"><Textarea rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </form>
    </Modal>
  )
}
