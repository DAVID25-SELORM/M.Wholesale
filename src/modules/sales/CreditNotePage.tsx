import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Printer } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, ErrorState, Field, InlineError, Input, LoadingState, Modal, PageHeader, Select, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { ReasonDialog } from '@/modules/purchasing/shared'
import { useSession } from '@/modules/session/SessionProvider'
import {
  CREDIT_REASONS, CREDIT_REASON_LABEL, RETURN_CONDITIONS, RETURN_CONDITION_LABEL, applyCreditNote, cancelCreditNote, getCreditNote, getCreditable, listCreditNoteAllocations,
  listCreditNoteLines, listCreditNoteReturns, postCreditNote, saveCreditNote, type CreditNote, type CreditNoteLine, type CreditReason,
} from '@/services/creditNotes'
import { fmtQty } from '@/services/inventory'
import { getOrganization } from '@/services/organization'
import { getSalesInvoice, listSalesAllocations, listSalesLines, moneyFmt } from '@/services/sales'
import { listWarehouseOptions } from '@/services/warehouses'
import { buildCreditLines, draftsFromLines, type CreditLineDraft, type InvoiceLineInfo } from './creditLines'
import { CreditStatusBadge } from './CreditNotesPage'

export function CreditNotePage() {
  const { id } = useParams()
  const [sp] = useSearchParams()
  const note = useQuery({ queryKey: ['credit-note', id], queryFn: () => getCreditNote(id!), enabled: Boolean(id) })
  if (!id) return <CreditEditor invoiceId={sp.get('invoice') ?? ''} note={null} />
  if (note.isPending) return <LoadingState />
  if (note.isError) return <ErrorState message={toAppError(note.error).message} onRetry={() => void note.refetch()} />
  if (!note.data) return <EmptyState title="Credit note not found" action={<Link className="text-sm font-medium text-brand-700 hover:underline" to="/sales/credit-notes">Back to credit notes</Link>} />
  if (note.data.status === 'DRAFT') return <CreditEditor key={note.data.updated_at} invoiceId={note.data.sales_invoice_id} note={note.data} openPost={sp.get('post') === '1'} />
  return <CreditView note={note.data} />
}

// ---- the draft editor -------------------------------------------------------------------------------------------
function CreditEditor({ invoiceId, note, openPost = false }: { invoiceId: string; note: CreditNote | null; openPost?: boolean }) {
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const invoice = useQuery({ queryKey: ['sales-invoice', invoiceId], queryFn: () => getSalesInvoice(invoiceId), enabled: Boolean(invoiceId) })
  const invLines = useQuery({ queryKey: ['sales-invoice-lines', invoiceId], queryFn: () => listSalesLines(invoiceId), enabled: Boolean(invoiceId) })
  const allocations = useQuery({ queryKey: ['sales-allocations', invoiceId], queryFn: () => listSalesAllocations(invoiceId), enabled: Boolean(invoiceId) })
  const creditable = useQuery({ queryKey: ['creditable', invoiceId], queryFn: () => getCreditable(invoiceId), enabled: Boolean(invoiceId) })
  const noteLines = useQuery({ queryKey: ['credit-note-lines', note?.id], queryFn: () => listCreditNoteLines(note!.id), enabled: Boolean(note) })
  const warehouses = useQuery({ queryKey: ['warehouse-options', null], queryFn: () => listWarehouseOptions(null), staleTime: 60_000 })

  if (!invoiceId) return <EmptyState title="Start from an invoice" description="Open a posted invoice and choose “Credit note”." action={<Link className="text-sm font-medium text-brand-700 hover:underline" to="/sales/invoices">Go to invoices</Link>} />
  if (invoice.isPending || invLines.isPending || creditable.isPending || warehouses.isPending || (note && noteLines.isPending)) return <LoadingState />
  for (const q of [invoice, invLines, creditable, warehouses, noteLines]) if (q.isError) return <ErrorState message={toAppError(q.error).message} onRetry={() => void q.refetch()} />
  const inv = invoice.data
  if (!inv || !invLines.data || !creditable.data || !warehouses.data) return <LoadingState />
  if (inv.status !== 'POSTED') return <EmptyState title="Only posted invoices can be credited" />

  const infos: InvoiceLineInfo[] = invLines.data.flatMap((l) => {
    const c = creditable.data.find((x) => x.invoice_line_id === l.id)
    return c ? [{ id: l.id, lineNo: l.line_no, label: l.product?.brand_name ?? l.product?.sku ?? 'Item', unitPrice: Number(l.unit_price), discountPercent: Number(l.discount_percent), taxRate: Number(l.tax_rate), creditable: c }] : []
  })
  return (
    <EditorBody
      key={note?.id ?? 'new'} invoice={inv} note={note} infos={infos} invLines={invLines.data} allocations={allocations.data ?? []} warehouses={warehouses.data}
      initial={note && noteLines.data ? draftsFromLines(noteLines.data, infos) : null}
      openPost={openPost} qc={qc} toast={toast} navigate={navigate} canRestockAt={(branch) => ability.can('credit_notes.restock', branch)} canPostAt={(branch) => ability.can('credit_notes.post', branch)} canCreateAt={(branch) => ability.can('credit_notes.create', branch)}
    />
  )
}

type Toast = ReturnType<typeof useToast>

function EditorBody({ invoice, note, infos, invLines, allocations, warehouses, initial, openPost, qc, toast, navigate, canRestockAt, canPostAt, canCreateAt }: {
  invoice: NonNullable<Awaited<ReturnType<typeof getSalesInvoice>>>
  note: CreditNote | null
  infos: InvoiceLineInfo[]
  invLines: Awaited<ReturnType<typeof listSalesLines>>
  allocations: Awaited<ReturnType<typeof listSalesAllocations>>
  warehouses: Awaited<ReturnType<typeof listWarehouseOptions>>
  initial: CreditLineDraft[] | null
  openPost: boolean
  qc: ReturnType<typeof useQueryClient>
  toast: Toast
  navigate: ReturnType<typeof useNavigate>
  canRestockAt: (branch: string) => boolean
  canPostAt: (branch: string) => boolean
  canCreateAt: (branch: string) => boolean
}) {
  const goodsTo = warehouses.filter((w) => (w.is_active || w.id === note?.warehouse_id) && canCreateAt(w.branch_id))
  const [warehouseId, setWarehouseId] = useState(note?.warehouse_id ?? (goodsTo.find((w) => w.id === invoice.warehouse_id) ?? goodsTo[0])?.id ?? '')
  const [reason, setReason] = useState<CreditReason>((note?.reason_code as CreditReason) ?? 'DAMAGED')
  const [notes, setNotes] = useState(note?.notes ?? '')
  const [rows, setRows] = useState<CreditLineDraft[]>(initial ?? infos.map((i) => ({ invoiceLineId: i.id, returnQty: '', condition: 'QUARANTINE', batchId: '', priceAmount: '', priceNote: '' })))
  const [error, setError] = useState<string | null>(null)
  const [posting, setPosting] = useState(openPost)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const branchId = goodsTo.find((w) => w.id === warehouseId)?.branch_id ?? invoice.branch_id
  const built = buildCreditLines(rows, infos, { canRestock: canRestockAt(branchId) })
  const patch = (invoiceLineId: string, p: Partial<CreditLineDraft>) => setRows((rs) => rs.map((r) => (r.invoiceLineId === invoiceLineId ? { ...r, ...p } : r)))
  const refresh = () => Promise.all(['credit-notes', 'credit-note', 'credit-note-lines', 'creditable', 'dashboard'].map((k) => qc.invalidateQueries({ queryKey: [k] })))

  const save = useMutation({
    mutationFn: (lines: Extract<typeof built, { ok: true }>['lines']) => saveCreditNote({ id: note?.id ?? null, invoiceId: invoice.id, warehouseId, reason, notes, lines }),
    onError: (e) => setError(toAppError(e).message),
  })
  const cancel = useMutation({
    mutationFn: (r: string) => cancelCreditNote(note!.id, r),
    onSuccess: async () => { toast.success('Draft cancelled.'); await refresh(); navigate(`/sales/invoices/${invoice.id}`) },
    onError: (e) => setCancelError(toAppError(e).message),
  })
  const post = useMutation({
    mutationFn: () => postCreditNote(note!.id),
    onSuccess: async (r) => {
      toast.success(`${r.credit_note_number} posted for ${moneyFmt(r.total_amount)}${r.unapplied > 0 ? `; ${moneyFmt(r.unapplied)} kept as the customer’s credit` : ''}.`)
      await Promise.all([refresh(), ...['sales-invoice', 'sales-invoices', 'customer-credit', 'customer-statement', 'open-invoices', 'receivables', 'balances', 'stock-documents', 'unused-credit'].map((k) => qc.invalidateQueries({ queryKey: [k] }))])
      setPosting(false)
      navigate(`/sales/credit-notes/${note!.id}`, { replace: true })
    },
    onError: (e) => setError(toAppError(e).message),
  })

  async function saveDraft(e?: FormEvent): Promise<string | null> {
    e?.preventDefault()
    if (!warehouseId) { setError('Choose the warehouse the goods come back to.'); return null }
    if (!built.ok) { setError(built.error); return null }
    setError(null)
    try {
      const id = await save.mutateAsync(built.lines)
      await refresh()
      if (!note) navigate(`/sales/credit-notes/${id}`, { replace: true })
      else toast.success('Draft saved.')
      return id
    } catch { return null }
  }
  async function saveAndPost() {
    const id = await saveDraft()
    if (id) navigate(`/sales/credit-notes/${id}?post=1`, { replace: true })
  }

  const hasReturn = built.ok && built.lines.some((l) => l.type === 'RETURN')
  return (
    <>
      <Link to={`/sales/invoices/${invoice.id}`} className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" aria-hidden /> {invoice.invoice_number}</Link>
      <PageHeader
        title={note ? 'Draft credit note' : 'New credit note'}
        description={`For invoice ${invoice.invoice_number} to ${invoice.customer?.name ?? ''}. A posted invoice is never edited: returned goods and price corrections are credited here.`}
        actions={note && <Button variant="ghost" onClick={() => { setCancelError(null); setCancelling(true) }}>Cancel draft</Button>}
      />
      <form onSubmit={(e) => void saveDraft(e)} noValidate className="space-y-5">
        <InlineError message={error} />
        <Card>
          <CardBody className="grid gap-3 sm:grid-cols-3">
            <Field label="Reason" required>
              <Select value={reason} onChange={(e) => setReason(e.target.value as CreditReason)}>
                {CREDIT_REASONS.map((r) => <option key={r} value={r}>{CREDIT_REASON_LABEL[r]}</option>)}
              </Select>
            </Field>
            <Field label="Goods come back to" required hint="Only needed when goods are returned.">
              <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                <option value="">Select…</option>
                {goodsTo.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </Field>
            <Field label="Notes"><Input value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} /></Field>
          </CardBody>
        </Card>

        <div className="space-y-3">
          {infos.map((info) => {
            const r = rows.find((x) => x.invoiceLineId === info.id)!
            const c = info.creditable
            const batches = [...new Map(allocations.filter((a) => a.sales_invoice_line_id === info.id && a.batch_id).map((a) => [a.batch_id!, a.batch])).entries()]
            const done = c.remaining_quantity <= 0 && c.remaining_net <= 0
            const lineValue = built.ok ? built.perLine[info.id] : undefined
            const sold = invLines.find((l) => l.id === info.id)
            const packName = Number(sold?.unit?.factor_to_base ?? 1) === 1 ? sold?.product?.base_unit?.name : sold?.unit?.unit?.name
            return (
              <fieldset key={info.id} disabled={done} className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/50 p-3 disabled:opacity-60">
                <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Line {info.lineNo}</legend>
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium text-slate-900">{info.label} <span className="text-xs font-normal text-slate-500">{sold?.product?.sku}</span></span>
                  <span className="text-slate-600">
                    Sold {fmtQty(c.quantity)} {packName} at {moneyFmt(info.unitPrice)}{info.discountPercent > 0 ? ` less ${info.discountPercent}%` : ''}
                    {c.returned_quantity > 0 || c.credited_net > 0 ? ` · already credited ${fmtQty(c.returned_quantity)} / ${moneyFmt(c.credited_net)}` : ''}
                  </span>
                </div>
                {done ? <p className="text-sm text-slate-500">Fully credited already.</p> : (
                  <div className="grid gap-3 sm:grid-cols-12">
                    <Field label={`Return (${packName ?? 'units'})`} className="sm:col-span-2" hint={`up to ${fmtQty(c.remaining_quantity)}`}>
                      <Input type="number" inputMode="decimal" min="0" step="any" value={r.returnQty} onChange={(e) => patch(info.id, { returnQty: e.target.value })} />
                    </Field>
                    <Field label="Condition of goods" className="sm:col-span-3">
                      <Select value={r.condition} onChange={(e) => patch(info.id, { condition: e.target.value as CreditLineDraft['condition'] })} disabled={r.returnQty.trim() === ''}>
                        {RETURN_CONDITIONS.filter((k) => k !== 'AVAILABLE' || canRestockAt(branchId) || r.condition === 'AVAILABLE').map((k) => <option key={k} value={k}>{RETURN_CONDITION_LABEL[k]}</option>)}
                      </Select>
                    </Field>
                    <Field label="From batch" className="sm:col-span-2">
                      <Select value={r.batchId} onChange={(e) => patch(info.id, { batchId: e.target.value })} disabled={r.returnQty.trim() === '' || batches.length < 2}>
                        <option value="">Any (latest first)</option>
                        {batches.map(([bid, b]) => <option key={bid} value={bid}>{b?.batch_number} (exp {b?.expiry_date})</option>)}
                      </Select>
                    </Field>
                    <Field label="Price correction" className="sm:col-span-2" hint={`up to ${moneyFmt(c.remaining_net)}`}>
                      <Input type="number" inputMode="decimal" min="0" step="0.01" value={r.priceAmount} onChange={(e) => patch(info.id, { priceAmount: e.target.value })} />
                    </Field>
                    <div className="flex flex-col justify-end pb-2 text-right text-sm sm:col-span-3">
                      {lineValue ? <span className="font-semibold tabular-nums text-slate-900">{moneyFmt(lineValue)}</span> : <span className="text-slate-400">—</span>}
                    </div>
                    {r.priceAmount.trim() !== '' && (
                      <Field label="Why the price changes" className="sm:col-span-12"><Input value={r.priceNote} maxLength={200} onChange={(e) => patch(info.id, { priceNote: e.target.value })} /></Field>
                    )}
                  </div>
                )}
              </fieldset>
            )
          })}
        </div>

        {rows.some((r) => r.condition === 'AVAILABLE' && r.returnQty.trim() !== '') && (
          <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />Goods marked “good” go straight back into sellable stock. Use quarantine unless they have been inspected.</p>
        )}

        <Card>
          <CardBody>
            <dl className="ml-auto w-full max-w-xs space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">Credit (before tax)</dt><dd className="tabular-nums">{built.ok ? moneyFmt(built.subtotal) : '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Tax</dt><dd className="tabular-nums">{built.ok ? moneyFmt(built.tax) : '—'}</dd></div>
              <div className="flex justify-between border-t border-slate-200 pt-1 text-base font-semibold"><dt>Total credit</dt><dd className="tabular-nums">{built.ok ? moneyFmt(built.total) : '—'}</dd></div>
            </dl>
          </CardBody>
        </Card>

        <div className="flex flex-wrap justify-end gap-2">
          <Link to={`/sales/invoices/${invoice.id}`}><Button type="button" variant="ghost">Back</Button></Link>
          <Button type="submit" variant="secondary" loading={save.isPending}>Save draft</Button>
          {note && canPostAt(branchId) && <Button type="button" onClick={() => setPosting(true)}>Post…</Button>}
          {!note && canPostAt(branchId) && <Button type="button" onClick={() => void saveAndPost()} loading={save.isPending}>Save and post…</Button>}
        </div>
      </form>

      {posting && note && (
        <Modal
          open size="md" onClose={() => setPosting(false)} title="Post this credit note"
          description="Posting is final. The customer owes less, and any returned goods are booked back into stock."
          footer={<><Button variant="secondary" onClick={() => setPosting(false)} disabled={post.isPending}>Back</Button><Button onClick={() => { setError(null); post.mutate() }} loading={post.isPending}>Post credit note</Button></>}
        >
          <div className="space-y-3 text-sm">
            <InlineError message={error} />
            <p>Credit <strong className="tabular-nums">{moneyFmt(note.total_amount)}</strong> against {invoice.invoice_number}{Number(invoice.balance_due ?? 0) < Number(note.total_amount) ? <>, which only owes <strong className="tabular-nums">{moneyFmt(invoice.balance_due)}</strong>: the rest stays as the customer’s credit.</> : '.'}</p>
            {hasReturn && <p className="text-slate-600">Returned goods go back into the batches they were sold from, in the condition you chose.</p>}
          </div>
        </Modal>
      )}
      {cancelling && (
        <ReasonDialog
          open title="Cancel this draft" description="The draft is discarded. Nothing was posted, so stock and the customer's account are unaffected." confirmLabel="Cancel draft" tone="danger"
          busy={cancel.isPending} error={cancelError} onConfirm={(r) => cancel.mutate(r)} onClose={() => setCancelling(false)}
        />
      )}
    </>
  )
}

// ---- posted / cancelled -------------------------------------------------------------------------------------------
function CreditView({ note }: { note: CreditNote }) {
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const lines = useQuery({ queryKey: ['credit-note-lines', note.id], queryFn: () => listCreditNoteLines(note.id) })
  const returns = useQuery({ queryKey: ['credit-note-returns', note.id], queryFn: () => listCreditNoteReturns(note.id), enabled: note.status === 'POSTED' })
  const allocs = useQuery({ queryKey: ['credit-note-allocations', note.id], queryFn: () => listCreditNoteAllocations(note.id), enabled: note.status === 'POSTED' })
  const org = useQuery({ queryKey: ['organization'], queryFn: getOrganization, staleTime: 5 * 60_000 })
  const apply = useMutation({
    mutationFn: () => applyCreditNote(note.id),
    onSuccess: async (n) => {
      toast.success(n > 0 ? `${moneyFmt(n)} applied to open invoices.` : 'Nothing to apply: the customer has no open invoices.')
      await Promise.all(['credit-note', 'credit-notes', 'credit-note-allocations', 'sales-invoice', 'sales-invoices', 'customer-credit', 'customer-statement', 'open-invoices', 'receivables', 'unused-credit', 'dashboard'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
    },
    onError: (e) => toast.error(toAppError(e).message),
  })
  if (lines.isPending) return <LoadingState />
  if (lines.isError) return <ErrorState message={toAppError(lines.error).message} onRetry={() => void lines.refetch()} />
  const o = org.data
  const unapplied = Number(note.unapplied_amount ?? 0)
  const factor = (l: CreditNoteLine) => Number(l.unit?.factor_to_base ?? 1)

  return (
    <>
      <div className="print-hidden">
        <Link to="/sales/credit-notes" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" aria-hidden /> Credit notes</Link>
        <PageHeader
          title={note.credit_note_number ?? 'Credit note'}
          description={`${note.customer?.name ?? ''} · for invoice ${note.invoice?.invoice_number ?? ''}${note.posted_at ? ` · posted ${formatDateTime(note.posted_at)}` : ''}`}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <CreditStatusBadge status={note.status} />
              {note.status === 'POSTED' && unapplied > 0 && ability.can('credit_notes.post', note.branch_id) && <Button onClick={() => apply.mutate()} loading={apply.isPending}>Apply {moneyFmt(unapplied)} to invoices</Button>}
              {note.status === 'POSTED' && <Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" aria-hidden /> Print</Button>}
            </div>
          }
        />
        {note.status === 'POSTED' && unapplied > 0 && (
          <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{moneyFmt(unapplied)} of this credit has not been used. It stays on the customer’s account and counts against what they owe until it is applied to an invoice.</p>
        )}
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
              <p className="text-xl font-bold tracking-wide text-slate-900">{note.status === 'CANCELLED' ? 'CANCELLED' : 'CREDIT NOTE'}</p>
              <p className="font-mono text-sm font-semibold">{note.credit_note_number}</p>
              <p className="text-sm text-slate-600">Date {note.credit_date}</p>
              <p className="text-sm text-slate-600">Invoice {note.invoice?.invoice_number}</p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Credit to</p>
              <p className="font-medium text-slate-900">{note.customer?.name}</p>
            </div>
            <div className="text-sm text-slate-600 sm:text-right">
              <p>Reason: {CREDIT_REASON_LABEL[note.reason_code as CreditReason] ?? note.reason_code}</p>
              {note.notes && <p>{note.notes}</p>}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">Credit note lines</caption>
              <thead className="border-b border-slate-300 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="py-2 pr-3">Item</th><th className="pr-3">Credit for</th><th className="pr-3 text-right">Net</th><th className="pr-3 text-right">Tax</th><th className="text-right">Amount</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(lines.data ?? []).map((l) => {
                  const back = (returns.data ?? []).filter((r) => r.credit_note_line_id === l.id)
                  return (
                    <tr key={l.id} className="align-top">
                      <td className="py-2 pr-3"><span className="font-medium text-slate-900">{l.product?.brand_name}</span> <span className="text-xs text-slate-500">{l.product?.sku}</span>
                        {back.length > 0 && <span className="print-hidden block text-xs text-slate-500">{back.map((r) => `${r.batch?.batch_number ?? '?'} (exp ${r.batch?.expiry_date ?? '?'}) × ${fmtQty(Number(r.base_quantity) / factor(l))} → ${RETURN_CONDITION_LABEL[r.return_condition as keyof typeof RETURN_CONDITION_LABEL]?.split(' - ')[0]?.toLowerCase()}`).join(' · ')}</span>}
                      </td>
                      <td className="pr-3 text-slate-600">{l.line_type === 'RETURN' ? `${fmtQty(Number(l.quantity))} ${factor(l) === 1 ? l.product?.base_unit?.name : l.unit?.unit?.name} returned` : (l.description || 'Price correction')}</td>
                      <td className="pr-3 text-right tabular-nums">{moneyFmt(l.line_net)}</td>
                      <td className="pr-3 text-right tabular-nums">{moneyFmt(l.line_tax)}</td>
                      <td className="text-right font-medium tabular-nums">{moneyFmt(l.line_total)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <dl className="ml-auto w-full max-w-xs space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">Credit before tax</dt><dd className="tabular-nums">{moneyFmt(note.subtotal)}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Tax</dt><dd className="tabular-nums">{moneyFmt(note.tax_total)}</dd></div>
            <div className="flex justify-between border-t border-slate-200 pt-1 text-base font-semibold"><dt>Total credit ({note.currency_code})</dt><dd className="tabular-nums">{moneyFmt(note.total_amount)}</dd></div>
          </dl>
        </div>
      </div>

      {(allocs.data ?? []).length > 0 && (
        <div className="print-hidden mt-5">
          <Card>
            <CardHeader title="Applied to invoices" />
            <CardBody>
              <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
                {(allocs.data ?? []).map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <Link to={`/sales/invoices/${a.sales_invoice_id}`} className="font-mono text-xs font-semibold text-brand-700 hover:underline">{a.invoice?.invoice_number}</Link>
                    <span className="tabular-nums">{moneyFmt(a.amount)}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
      )}
      {note.status === 'CANCELLED' && note.status_reason && <p className="print-hidden mt-4 text-sm text-slate-600"><Badge>Cancelled</Badge> {note.status_reason}</p>}
    </>
  )
}
