import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  Badge, Button, Card, DataTable, EmptyState, ErrorState, Field, InlineError, Input, LoadingState, Modal, PageHeader, Pagination, SearchInput,
  Select, Textarea, useToast, type Column,
} from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { useSession } from '@/modules/session/SessionProvider'
import { fmtQty } from '@/services/inventory'
import {
  INVOICE_STATUSES, INVOICE_STATUS_LABEL, INVOICE_STATUS_TONE, MATCH_LABEL, approveSupplierInvoice, cancelSupplierInvoice, listBillableLines,
  listInvoiceLines, listSupplierInvoices, paySupplierInvoice, recordSupplierInvoice, type InvoiceStatus, type MatchStatus, type SupplierInvoice,
} from '@/services/payables'
import { listPurchaseOrderLines, listPurchaseOrders, money } from '@/services/purchasing'
import { listSupplierOptions } from '@/services/suppliers'
import { buildInvoiceLines, previewMatch, type InvoiceLineDraft } from './invoiceLines'
import { ReasonDialog } from './shared'

const PAGE_SIZE = 20
const today = () => new Date().toISOString().slice(0, 10)

export function InvoiceStatusBadge({ status }: { status: string }) {
  const s = status as InvoiceStatus
  return <Badge tone={INVOICE_STATUS_TONE[s] ?? 'slate'}>{INVOICE_STATUS_LABEL[s] ?? status}</Badge>
}

export function SupplierInvoicesPage() {
  const { ability } = useSession()
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<InvoiceStatus | ''>('')
  const [supplierId, setSupplierId] = useState('')
  const [recording, setRecording] = useState(false)
  const [open, setOpen] = useState<SupplierInvoice | null>(null)
  const suppliers = useQuery({ queryKey: ['supplier-options'], queryFn: listSupplierOptions, staleTime: 60_000 })
  const params = { page, pageSize: PAGE_SIZE, search, status, supplierId }
  const query = useQuery({ queryKey: ['supplier-invoices', params], queryFn: () => listSupplierInvoices(params), placeholderData: (prev) => prev })

  const columns: Column<SupplierInvoice>[] = [
    { key: 'no', header: 'Invoice', render: (i) => <button type="button" className="text-left" onClick={() => setOpen(i)}><span className="block font-mono text-xs font-semibold text-brand-700 hover:underline">{i.invoice_number}</span><span className="block text-xs text-slate-500">their no. {i.supplier_invoice_number}</span></button> },
    { key: 'supplier', header: 'Supplier', render: (i) => <span className="font-medium text-slate-900">{i.supplier?.name ?? '—'}</span> },
    { key: 'po', header: 'Order', hideOnMobile: true, render: (i) => (i.purchase_order ? <Link className="font-mono text-xs hover:underline" to={`/purchasing/orders/${i.purchase_order_id}`}>{i.purchase_order.po_number}</Link> : '—') },
    { key: 'status', header: 'Status', render: (i) => <InvoiceStatusBadge status={i.status} /> },
    { key: 'total', header: 'Total', className: 'text-right', render: (i) => <span className="whitespace-nowrap tabular-nums">{money(i.total_amount, i.currency_code)}</span> },
    { key: 'due', header: 'Due', hideOnMobile: true, render: (i) => <span className={i.status === 'APPROVED' && i.due_date < today() ? 'font-semibold text-red-700' : 'text-slate-600'}>{i.due_date}</span> },
  ]

  return (
    <>
      <PageHeader
        title="Supplier invoices"
        description="Each invoice is checked against the purchase order and what was actually received before it can be approved for payment."
        actions={ability.canAnywhere('payables.create') && <Button onClick={() => setRecording(true)}><Plus className="h-4 w-4" aria-hidden /> Record invoice</Button>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center">
          <div className="flex-1"><SearchInput value={search} onChange={(v) => { setSearch(v); setPage(0) }} placeholder="Search by our number or the supplier’s invoice number" label="Search invoices" /></div>
          <div className="w-full lg:w-52">
            <label htmlFor="inv-status" className="sr-only">Status</label>
            <Select id="inv-status" value={status} onChange={(e) => { setStatus(e.target.value as InvoiceStatus | ''); setPage(0) }}>
              <option value="">All statuses</option>
              {INVOICE_STATUSES.map((s) => <option key={s} value={s}>{INVOICE_STATUS_LABEL[s]}</option>)}
            </Select>
          </div>
          <div className="w-full lg:w-60">
            <label htmlFor="inv-supplier" className="sr-only">Supplier</label>
            <Select id="inv-supplier" value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setPage(0) }}>
              <option value="">All suppliers</option>
              {(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>
        </div>
        <DataTable
          caption="Supplier invoices" columns={columns} rows={query.data?.rows} rowKey={(i) => i.id} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()}
          emptyTitle="No supplier invoices" emptyDescription="Record an invoice against an approved purchase order once goods have arrived."
        />
        <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>
      {recording && <RecordDialog invoice={null} onClose={() => setRecording(false)} onSaved={(id) => { setRecording(false); void id }} />}
      <InvoiceDialog invoice={open} onClose={() => setOpen(null)} />
    </>
  )
}

// ---- record / edit ----------------------------------------------------------------------------------------------
function RecordDialog({ invoice, onClose, onSaved }: { invoice: SupplierInvoice | null; onClose: () => void; onSaved: (id: string) => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [poId, setPoId] = useState(invoice?.purchase_order_id ?? '')
  const [number, setNumber] = useState(invoice?.supplier_invoice_number ?? '')
  const [date, setDate] = useState(invoice?.invoice_date ?? today())
  const [tax, setTax] = useState(invoice ? String(Number(invoice.tax_amount)) : '0')
  const [notes, setNotes] = useState(invoice?.notes ?? '')
  const [drafts, setDrafts] = useState<InvoiceLineDraft[] | null>(null)
  const [loadedFor, setLoadedFor] = useState('')
  const [error, setError] = useState<string | null>(null)

  const orders = useQuery({
    queryKey: ['purchase-orders', 'invoiceable'], queryFn: () => listPurchaseOrders({ page: 0, pageSize: 100, search: '', status: '', supplierId: '' }),
  })
  const eligible = (orders.data?.rows ?? []).filter((o) => ['APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'].includes(o.status))
  const poLines = useQuery({ queryKey: ['purchase-order-lines', poId], queryFn: () => listPurchaseOrderLines(poId), enabled: Boolean(poId) })
  const own = useQuery({ queryKey: ['supplier-invoice-lines', invoice?.id], queryFn: () => listInvoiceLines(invoice!.id), enabled: Boolean(invoice) })

  const billable = useQuery({
    queryKey: ['billable', poId, invoice?.id],
    queryFn: () => listBillableLines(poLines.data ?? []),
    enabled: Boolean(poLines.data) && (!invoice || Boolean(own.data)),
  })

  // build the editable rows once, when the order's lines (and, when editing, the invoice's own lines) have loaded
  if (billable.data && loadedFor !== `${poId}|${invoice?.id ?? ''}`) {
    setLoadedFor(`${poId}|${invoice?.id ?? ''}`)
    setDrafts(billable.data.map((b) => {
      const mine = own.data?.find((l) => l.po_line_id === b.line.id)
      const allowed = b.allowedPacks + (mine ? Number(mine.quantity) : 0)
      return {
        poLineId: b.line.id, include: mine ? true : allowed > 0,
        quantity: mine ? String(Number(mine.quantity)) : allowed > 0 ? String(allowed) : '', price: mine ? String(Number(mine.unit_price)) : String(Number(b.line.unit_cost)),
        poPrice: Number(b.line.unit_cost), allowed,
      }
    }))
  }

  const names = Object.fromEntries((poLines.data ?? []).map((l) => [l.id, l.product?.brand_name ?? 'A line']))
  const built = drafts ? buildInvoiceLines(drafts, names) : null
  const taxN = Number(tax)
  const patch = (id: string, p: Partial<InvoiceLineDraft>) => setDrafts((ds) => (ds ?? []).map((d) => (d.poLineId === id ? { ...d, ...p } : d)))

  const save = useMutation({
    mutationFn: (lines: Extract<NonNullable<typeof built>, { ok: true }>['lines']) =>
      recordSupplierInvoice({ id: invoice?.id ?? null, purchaseOrderId: poId, supplierInvoiceNumber: number.trim(), invoiceDate: date, taxAmount: taxN, notes, lines }),
    onSuccess: async (id) => {
      toast.success(invoice ? 'Invoice updated and re-checked.' : 'Invoice recorded and checked.')
      await Promise.all(['supplier-invoices', 'supplier-invoice-lines', 'payables'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
      onSaved(id)
    },
    onError: (e) => setError(toAppError(e).message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!poId) { setError('Choose the purchase order this invoice is for.'); return }
    if (!number.trim()) { setError('Enter the supplier’s invoice number.'); return }
    if (!date) { setError('Enter the invoice date.'); return }
    if (tax.trim() === '' || !Number.isFinite(taxN) || taxN < 0) { setError('Tax must be 0 or more.'); return }
    if (!built || !built.ok) { setError(built && !built.ok ? built.error : 'Loading the order lines…'); return }
    setError(null)
    save.mutate(built.lines)
  }

  return (
    <Modal
      open size="lg" onClose={onClose} title={invoice ? `Edit ${invoice.invoice_number}` : 'Record a supplier invoice'}
      description="Enter what the supplier billed. We compare it with the order and the goods received."
      footer={<><Button variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button><Button type="submit" form="sinv-form" loading={save.isPending}>{invoice ? 'Save and re-check' : 'Record invoice'}</Button></>}
    >
      <form id="sinv-form" onSubmit={submit} noValidate className="space-y-4">
        <InlineError message={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Purchase order" required>
            <Select value={poId} disabled={Boolean(invoice)} onChange={(e) => { setPoId(e.target.value); setDrafts(null); setLoadedFor('') }}>
              <option value="">Select…</option>
              {eligible.map((o) => <option key={o.id} value={o.id}>{o.po_number} · {o.supplier?.name}</option>)}
              {invoice && !eligible.some((o) => o.id === invoice.purchase_order_id) && <option value={invoice.purchase_order_id}>{invoice.purchase_order?.po_number}</option>}
            </Select>
          </Field>
          <Field label="Supplier’s invoice number" required><Input value={number} maxLength={60} onChange={(e) => setNumber(e.target.value)} autoComplete="off" /></Field>
          <Field label="Invoice date" required><Input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Tax on the invoice" hint="One amount for the whole invoice."><Input type="number" inputMode="decimal" min="0" step="0.01" value={tax} onChange={(e) => setTax(e.target.value)} /></Field>
        </div>

        {poId && (poLines.isPending || billable.isPending || !drafts) ? <LoadingState /> : drafts && (
          <div className="overflow-x-auto rounded-md border border-slate-200">
            <table className="min-w-full text-sm">
              <caption className="sr-only">Invoice lines</caption>
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="px-3 py-2">On invoice</th><th className="px-3 py-2">Product</th><th className="px-3 py-2 text-right">Can be billed</th><th className="px-3 py-2 text-right">Quantity</th><th className="px-3 py-2 text-right">Price / pack</th><th className="px-3 py-2">Check</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {drafts.map((d) => {
                  const m = d.include ? previewMatch(d) : null
                  return (
                    <tr key={d.poLineId}>
                      <td className="px-3 py-2"><input type="checkbox" aria-label={`${names[d.poLineId]} is on the invoice`} checked={d.include} onChange={(e) => patch(d.poLineId, { include: e.target.checked })} className="h-4 w-4 rounded border-slate-300" /></td>
                      <td className="px-3 py-2 font-medium text-slate-900">{names[d.poLineId]}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtQty(d.allowed)}</td>
                      <td className="px-3 py-2 text-right"><Input aria-label={`Invoiced quantity for ${names[d.poLineId]}`} type="number" inputMode="decimal" min="0" step="any" className="ml-auto h-8 w-24 text-right" disabled={!d.include} value={d.quantity} onChange={(e) => patch(d.poLineId, { quantity: e.target.value })} /></td>
                      <td className="px-3 py-2 text-right"><Input aria-label={`Invoiced price for ${names[d.poLineId]}`} type="number" inputMode="decimal" min="0" step="any" className="ml-auto h-8 w-28 text-right" disabled={!d.include} value={d.price} onChange={(e) => patch(d.poLineId, { price: e.target.value })} /></td>
                      <td className="px-3 py-2">{m ? <Badge tone={m === 'MATCHED' ? 'green' : 'amber'}>{MATCH_LABEL[m]}</Badge> : <span className="text-slate-400">—</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {built?.ok && <p className="text-right text-sm text-slate-700">Lines {built.subtotal.toFixed(2)} + tax {Number.isFinite(taxN) ? taxN.toFixed(2) : '0.00'} = <strong>{(built.subtotal + (Number.isFinite(taxN) ? taxN : 0)).toFixed(2)}</strong></p>}
        <Field label="Notes"><Textarea rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </form>
    </Modal>
  )
}

// ---- one invoice: result of the match, and what happens next -----------------------------------------------------
type Action = 'approve' | 'cancel' | 'pay' | 'edit' | null

export function InvoiceDialog({ invoice, onClose }: { invoice: SupplierInvoice | null; onClose: () => void }) {
  return invoice ? <InvoiceInner key={invoice.id} invoice={invoice} onClose={onClose} /> : null
}

function InvoiceInner({ invoice, onClose }: { invoice: SupplierInvoice; onClose: () => void }) {
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const lines = useQuery({ queryKey: ['supplier-invoice-lines', invoice.id], queryFn: () => listInvoiceLines(invoice.id) })
  const [action, setAction] = useState<Action>(null)
  const [reasonError, setReasonError] = useState<string | null>(null)
  const [paidOn, setPaidOn] = useState(today())
  const [reference, setReference] = useState('')
  const [payError, setPayError] = useState<string | null>(null)

  const refresh = () => Promise.all(['supplier-invoices', 'supplier-invoice-lines', 'payables'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
  const status = invoice.status as InvoiceStatus
  const can = (p: string) => ability.can(p, invoice.branch_id)
  const exceptions = (lines.data ?? []).filter((l) => l.match_status !== 'MATCHED').length

  const approve = useMutation({
    mutationFn: (reason?: string) => approveSupplierInvoice(invoice.id, reason),
    onSuccess: async () => { toast.success('Approved for payment.'); setAction(null); await refresh(); onClose() },
    onError: (e) => { setReasonError(toAppError(e).message); toast.error(toAppError(e).message) },
  })
  const cancel = useMutation({
    mutationFn: (reason: string) => cancelSupplierInvoice(invoice.id, reason),
    onSuccess: async () => { toast.success('Invoice cancelled.'); setAction(null); await refresh(); onClose() },
    onError: (e) => setReasonError(toAppError(e).message),
  })
  const pay = useMutation({
    mutationFn: () => paySupplierInvoice(invoice.id, paidOn, reference.trim()),
    onSuccess: async () => { toast.success('Marked as paid.'); await refresh(); onClose() },
    onError: (e) => setPayError(toAppError(e).message),
  })

  function submitPay(e: FormEvent) {
    e.preventDefault()
    if (!reference.trim()) { setPayError('Enter the payment reference (cheque, transfer or MoMo number).'); return }
    setPayError(null)
    pay.mutate()
  }

  return (
    <>
      <Modal
        open size="lg" onClose={onClose} title={`${invoice.invoice_number} · ${invoice.supplier?.name ?? ''}`}
        description={`Their invoice ${invoice.supplier_invoice_number} dated ${invoice.invoice_date}, due ${invoice.due_date}${invoice.purchase_order ? ` · order ${invoice.purchase_order.po_number}` : ''}`}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            {(status === 'MATCHED' || status === 'EXCEPTION') && can('payables.create') && <Button variant="secondary" onClick={() => setAction('edit')}>Edit</Button>}
            {(status === 'MATCHED' || status === 'EXCEPTION') && can('payables.approve') && (
              status === 'MATCHED'
                ? <Button loading={approve.isPending} onClick={() => approve.mutate(undefined)}>Approve for payment</Button>
                : <Button onClick={() => { setReasonError(null); setAction('approve') }}>Approve despite mismatch…</Button>
            )}
            {(status === 'MATCHED' || status === 'EXCEPTION' || status === 'APPROVED') && can(status === 'APPROVED' ? 'payables.approve' : 'payables.create') && <Button variant="ghost" onClick={() => { setReasonError(null); setAction('cancel') }}>Cancel invoice</Button>}
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </div>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <InvoiceStatusBadge status={status} />
          {status === 'EXCEPTION' && <span className="text-sm text-amber-800">{exceptions} {exceptions === 1 ? 'line does' : 'lines do'} not match the order and receipts.</span>}
          {invoice.variance_reason && <span className="rounded-md bg-amber-50 px-2 py-1 text-sm text-amber-900">Accepted: {invoice.variance_reason}</span>}
          {invoice.status_reason && <span className="rounded-md bg-slate-100 px-2 py-1 text-sm text-slate-700">{invoice.status_reason}</span>}
        </div>
        {lines.isPending ? <LoadingState /> : lines.isError ? <ErrorState message={toAppError(lines.error).message} onRetry={() => void lines.refetch()} /> : (lines.data ?? []).length === 0 ? <EmptyState title="No lines" /> : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">Invoice lines</caption>
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-2 pr-3">Product</th><th className="pr-3 text-right">Invoiced</th><th className="pr-3 text-right">Could be billed</th><th className="pr-3 text-right">Price</th><th className="pr-3 text-right">Order price</th><th className="pr-3">Check</th><th className="text-right">Total</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {(lines.data ?? []).map((l) => (
                  <tr key={l.id}>
                    <td className="py-2 pr-3"><span className="font-medium">{l.product?.brand_name}</span> <span className="font-mono text-xs text-slate-500">{l.product?.sku}</span></td>
                    <td className="pr-3 text-right tabular-nums">{fmtQty(Number(l.quantity))} {l.po_line?.unit?.unit?.name?.toLowerCase()}</td>
                    <td className="pr-3 text-right tabular-nums text-slate-500">{fmtQty(Number(l.allowed_quantity))}</td>
                    <td className="pr-3 text-right tabular-nums">{Number(l.unit_price).toFixed(2)}</td>
                    <td className="pr-3 text-right tabular-nums text-slate-500">{Number(l.po_unit_cost).toFixed(2)}</td>
                    <td className="pr-3"><Badge tone={l.match_status === 'MATCHED' ? 'green' : 'amber'}>{MATCH_LABEL[l.match_status as MatchStatus]}</Badge></td>
                    <td className="text-right tabular-nums font-medium">{Number(l.line_total).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="text-sm">
                <tr><td colSpan={6} className="pt-3 text-right text-slate-500">Lines</td><td className="pt-3 text-right tabular-nums">{Number(invoice.subtotal).toFixed(2)}</td></tr>
                <tr><td colSpan={6} className="text-right text-slate-500">Tax</td><td className="text-right tabular-nums">{Number(invoice.tax_amount).toFixed(2)}</td></tr>
                <tr><td colSpan={6} className="text-right font-semibold">Total {invoice.currency_code}</td><td className="text-right font-semibold tabular-nums">{Number(invoice.total_amount).toFixed(2)}</td></tr>
              </tfoot>
            </table>
          </div>
        )}
        {status === 'APPROVED' && can('payables.pay') && (
          <form onSubmit={submitPay} noValidate className="mt-4 space-y-3 border-t border-slate-100 pt-4">
            <h3 className="text-sm font-semibold text-slate-700">Mark as paid</h3>
            <p className="text-xs text-slate-500">Records that it was paid; the payment itself is made outside this system for now.</p>
            <InlineError message={payError} />
            <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
              <Field label="Paid on" required><Input type="date" value={paidOn} max={today()} onChange={(e) => setPaidOn(e.target.value)} /></Field>
              <Field label="Payment reference" required><Input value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} autoComplete="off" /></Field>
              <Button type="submit" loading={pay.isPending}>Mark as paid</Button>
            </div>
          </form>
        )}
        {status === 'PAID' && <p className="mt-4 border-t border-slate-100 pt-4 text-sm text-slate-700">Paid on <strong>{invoice.paid_on}</strong>, reference <strong>{invoice.payment_reference}</strong>.</p>}
        {invoice.approved_at && <p className="mt-2 text-xs text-slate-500">Approved {formatDateTime(invoice.approved_at)}</p>}
      </Modal>

      {action === 'edit' && <RecordDialog invoice={invoice} onClose={() => setAction(null)} onSaved={() => { setAction(null); onClose() }} />}
      {action === 'approve' && (
        <ReasonDialog
          open title="Approve despite the mismatch" description="This invoice differs from the order or what was received. Say why it is acceptable - the reason is kept with the invoice and in the audit log."
          confirmLabel="Approve for payment" busy={approve.isPending} error={reasonError} onConfirm={(r) => approve.mutate(r)} onClose={() => setAction(null)}
        />
      )}
      {action === 'cancel' && (
        <ReasonDialog
          open title="Cancel this invoice" description="The quantities it billed become available for another invoice." confirmLabel="Cancel invoice" tone="danger"
          busy={cancel.isPending} error={reasonError} onConfirm={(r) => cancel.mutate(r)} onClose={() => setAction(null)}
        />
      )}
    </>
  )
}
