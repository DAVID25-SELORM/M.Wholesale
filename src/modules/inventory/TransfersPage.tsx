import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Truck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import {
  Badge, Button, Card, DataTable, EmptyState, ErrorState, Field, InlineError, Input, LoadingState, Modal, PageHeader, Pagination, Select, Textarea,
  useToast, type Column,
} from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { ProductPicker } from '@/modules/catalog/ProductPicker'
import { ReasonDialog } from '@/modules/purchasing/shared'
import { useSession } from '@/modules/session/SessionProvider'
import { listProductUnits, type ProductRow } from '@/services/catalog'
import { STOCK_STATUSES, STOCK_STATUS_LABEL, fmtQty, listLocationOptions, listProductBalances, type BalanceRow, type StockStatus } from '@/services/inventory'
import {
  TRANSFER_STATUSES, TRANSFER_STATUS_LABEL, TRANSFER_STATUS_TONE, cancelTransfer, closeTransfer, dispatchTransfer, listStockTransfers, listTransferLines,
  outstandingBase, receiveTransfer, type StockTransfer, type StockTransferLine, type TransferStatus,
} from '@/services/transfers'
import { listWarehouseOptions } from '@/services/warehouses'
import { emptyReceivePart, buildTransferReceipt, type ReceivePart } from './transferLines'
import { StockStatusBadge } from './shared'

const PAGE_SIZE = 20

export function TransfersPage() {
  const { ability } = useSession()
  const [page, setPage] = useState(0)
  const [status, setStatus] = useState<TransferStatus | 'OPEN' | ''>('OPEN')
  const [sending, setSending] = useState(false)
  const [open, setOpen] = useState<StockTransfer | null>(null)
  const params = { page, pageSize: PAGE_SIZE, status: status === 'OPEN' ? ('' as const) : status, openOnly: status === 'OPEN' }
  const query = useQuery({ queryKey: ['stock-transfers', params], queryFn: () => listStockTransfers(params), placeholderData: (prev) => prev })

  const columns: Column<StockTransfer>[] = [
    { key: 'no', header: 'Transfer', render: (t) => <button type="button" className="font-mono text-xs font-semibold text-brand-700 hover:underline" onClick={() => setOpen(t)}>{t.transfer_number}</button> },
    { key: 'route', header: 'From → to', render: (t) => <span>{t.from_warehouse?.name} <span className="text-slate-400">→</span> {t.to_warehouse?.name}</span> },
    { key: 'status', header: 'Status', render: (t) => <Badge tone={TRANSFER_STATUS_TONE[t.status as TransferStatus] ?? 'blue'}>{TRANSFER_STATUS_LABEL[t.status as TransferStatus] ?? t.status}</Badge> },
    { key: 'lines', header: 'Lines', hideOnMobile: true, className: 'text-right', render: (t) => <span className="tabular-nums">{t.line_count}</span> },
    { key: 'when', header: 'Sent', render: (t) => <span className="whitespace-nowrap text-slate-600">{formatDateTime(t.dispatched_at)}</span> },
  ]

  return (
    <>
      <PageHeader
        title="Transfers"
        description="Stock travelling between warehouses. It leaves the sender when dispatched and reaches the receiver only when they book it in, so goods on the road are never counted twice."
        actions={ability.canAnywhere('inventory.transfer') && <Button onClick={() => setSending(true)}><Truck className="h-4 w-4" aria-hidden /> Send stock</Button>}
      />
      <Card>
        <div className="border-b border-slate-100 p-4">
          <div className="w-full sm:w-60">
            <label htmlFor="tr-status" className="sr-only">Show</label>
            <Select id="tr-status" value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setPage(0) }}>
              <option value="OPEN">Still on the way</option>
              <option value="">All transfers</option>
              {TRANSFER_STATUSES.map((s) => <option key={s} value={s}>{TRANSFER_STATUS_LABEL[s]}</option>)}
            </Select>
          </div>
        </div>
        <DataTable
          caption="Transfers" columns={columns} rows={query.data?.rows} rowKey={(t) => t.id} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()}
          emptyTitle={status === 'OPEN' ? 'Nothing is on the way' : 'No transfers'}
          emptyDescription="Use “Send stock” to move goods to another warehouse. (Quick moves inside one building can still use Transfer on the Stock page.)"
        />
        <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>
      {sending && <SendDialog onClose={() => setSending(false)} />}
      <TransferDialog transfer={open} onClose={() => setOpen(null)} />
    </>
  )
}

// ---- send ----------------------------------------------------------------------------------------------------------
interface Draft { key: string; product: ProductRow | null; unitId: string; factor: number; quantity: string; balance: BalanceRow | null }
let seq = 0
const nextKey = () => `t${++seq}`
const blank = (): Draft => ({ key: nextKey(), product: null, unitId: '', factor: 1, quantity: '', balance: null })

function SendDialog({ onClose }: { onClose: () => void }) {
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const warehouses = useQuery({ queryKey: ['warehouse-options', null], queryFn: () => listWarehouseOptions(null), staleTime: 60_000 })
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [notes, setNotes] = useState('')
  const [rows, setRows] = useState<Draft[]>(() => [blank()])
  const [error, setError] = useState<string | null>(null)
  const patch = (key: string, p: Partial<Draft>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))
  const senders = (warehouses.data ?? []).filter((w) => w.is_active && ability.can('inventory.transfer', w.branch_id))
  const receivers = (warehouses.data ?? []).filter((w) => w.is_active && w.id !== from)

  const send = useMutation({
    mutationFn: () =>
      dispatchTransfer(from, to, rows.map((r) => ({
        product_id: r.product!.id, quantity: Number(r.quantity), ...(r.unitId ? { product_unit_id: r.unitId } : {}),
        ...(r.balance?.batch_id ? { batch_id: r.balance.batch_id } : {}), ...(r.balance?.location_id ? { location_id: r.balance.location_id } : {}),
        status: r.balance!.stock_status,
      })), notes),
    onSuccess: async (r) => {
      toast.success(`${r.transfer_number} dispatched - the goods are on their way.`)
      await Promise.all(['stock-transfers', 'stock', 'balances', 'stock-documents', 'dashboard'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
      onClose()
    },
    onError: (e) => setError(toAppError(e).message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!from) { setError('Choose the warehouse the goods leave from.'); return }
    if (!to) { setError('Choose the warehouse they are going to.'); return }
    const taken = new Map<string, number>()
    for (const [i, r] of rows.entries()) {
      const fail = (m: string) => setError(`Line ${i + 1}: ${m}`)
      if (!r.product) return fail('choose a product.')
      if (!r.balance) return fail('choose which stock is being sent.')
      const qty = Number(r.quantity)
      if (r.quantity.trim() === '' || !Number.isFinite(qty) || qty <= 0) return fail('enter a quantity greater than 0.')
      const used = (taken.get(r.balance.id) ?? 0) + qty * r.factor
      taken.set(r.balance.id, used)
      if (used > r.balance.quantity + 1e-9) return fail(`only ${fmtQty(r.balance.quantity)} is in that stock.`)
    }
    setError(null)
    send.mutate()
  }

  return (
    <Modal
      open size="lg" onClose={onClose} title="Send stock to another warehouse"
      description="The goods leave your stock now and are on the road until the receiving warehouse books them in."
      footer={<><Button variant="secondary" onClick={onClose} disabled={send.isPending}>Cancel</Button><Button type="submit" form="send-form" loading={send.isPending}>Dispatch</Button></>}
    >
      <form id="send-form" onSubmit={submit} noValidate className="space-y-4">
        <InlineError message={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From warehouse" required>
            <Select value={from} onChange={(e) => { setFrom(e.target.value); setTo(''); setRows((rs) => rs.map((r) => ({ ...r, balance: null }))) }}>
              <option value="">Select…</option>
              {senders.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </Field>
          <Field label="To warehouse" required>
            <Select value={to} onChange={(e) => setTo(e.target.value)} disabled={!from}>
              <option value="">Select…</option>
              {receivers.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </Field>
        </div>
        <div className="space-y-3">
          {rows.map((r, i) => (
            <LineEditor key={r.key} index={i} row={r} warehouseId={from} onChange={(p) => patch(r.key, p)} onRemove={rows.length > 1 ? () => setRows((x) => x.filter((y) => y.key !== r.key)) : null} />
          ))}
          <Button type="button" variant="secondary" size="sm" onClick={() => setRows((x) => [...x, blank()])} disabled={rows.length >= 200}><Plus className="h-4 w-4" aria-hidden /> Add line</Button>
        </div>
        <Field label="Notes" hint="Vehicle, driver, waybill number…"><Textarea rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </form>
    </Modal>
  )
}

function LineEditor({ index, row, warehouseId, onChange, onRemove }: { index: number; row: Draft; warehouseId: string; onChange: (p: Partial<Draft>) => void; onRemove: (() => void) | null }) {
  const pid = row.product?.id
  const units = useQuery({ queryKey: ['product-units', pid], queryFn: () => listProductUnits(pid!), enabled: Boolean(pid) })
  const balances = useQuery({ queryKey: ['balances', pid, warehouseId], queryFn: () => listProductBalances(pid!, warehouseId), enabled: Boolean(pid && warehouseId) })
  const usable = (units.data ?? []).filter((u) => u.is_active)
  const base = usable.find((u) => u.is_base)?.unit?.name ?? 'base unit'
  return (
    <fieldset className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/50 p-3">
      <legend className="flex w-full items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <span>Line {index + 1}</span>
        {onRemove && <button type="button" onClick={onRemove} className="inline-flex items-center gap-1 text-slate-500 hover:text-red-600" aria-label={`Remove line ${index + 1}`}><Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove</button>}
      </legend>
      <ProductPicker value={row.product} onChange={(p) => onChange({ product: p, unitId: '', factor: 1, balance: null })} />
      {row.product && (
        <div className="grid gap-3 sm:grid-cols-6">
          <Field label="Quantity" required className="sm:col-span-2"><Input type="number" inputMode="decimal" min="0" step="any" value={row.quantity} onChange={(e) => onChange({ quantity: e.target.value })} /></Field>
          <Field label="In" className="sm:col-span-2" hint={row.factor !== 1 && Number(row.quantity) > 0 ? `= ${fmtQty(Number(row.quantity) * row.factor)} ${base.toLowerCase()}` : undefined}>
            <Select value={row.unitId} onChange={(e) => onChange({ unitId: e.target.value, factor: Number(usable.find((u) => u.id === e.target.value)?.factor_to_base ?? 1) })}>
              <option value="">{base}</option>
              {usable.filter((u) => !u.is_base).map((u) => <option key={u.id} value={u.id}>{u.unit?.name} (×{Number(u.factor_to_base)})</option>)}
            </Select>
          </Field>
          <Field label="Take from" required className="sm:col-span-6">
            <Select value={row.balance?.id ?? ''} disabled={!warehouseId} onChange={(e) => onChange({ balance: balances.data?.find((b) => b.id === e.target.value) ?? null })}>
              <option value="">{!warehouseId ? 'Choose the sending warehouse first' : balances.isFetching ? 'Loading stock…' : (balances.data ?? []).length === 0 ? 'No stock of this product here' : 'Select batch…'}</option>
              {(balances.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {[b.batch ? `Batch ${b.batch.batch_number} (exp ${b.batch.expiry_date})` : 'No batch', STOCK_STATUS_LABEL[b.stock_status], b.location ? `Loc ${b.location.code}` : null, `${fmtQty(b.quantity)} on hand`].filter(Boolean).join(' · ')}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </fieldset>
  )
}

// ---- one transfer ---------------------------------------------------------------------------------------------------
type Action = 'receive' | 'close' | 'cancel' | null

function TransferDialog({ transfer, onClose }: { transfer: StockTransfer | null; onClose: () => void }) {
  return transfer ? <TransferInner key={transfer.id} transfer={transfer} onClose={onClose} /> : null
}

function TransferInner({ transfer, onClose }: { transfer: StockTransfer; onClose: () => void }) {
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const lines = useQuery({ queryKey: ['stock-transfer-lines', transfer.id], queryFn: () => listTransferLines(transfer.id) })
  const [action, setAction] = useState<Action>(null)
  const [reasonError, setReasonError] = useState<string | null>(null)
  const status = transfer.status as TransferStatus
  const onTheWay = status === 'IN_TRANSIT' || status === 'PARTIALLY_RECEIVED'
  const canReceive = onTheWay && ability.can('inventory.transfer', transfer.to_branch_id)
  const canClose = onTheWay && ability.can('inventory.adjust', transfer.from_branch_id)
  const canCancel = status === 'IN_TRANSIT' && ability.can('inventory.transfer', transfer.from_branch_id)

  const refresh = () => Promise.all(['stock-transfers', 'stock-transfer-lines', 'stock', 'balances', 'stock-documents', 'dashboard'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
  const withReason = useMutation({
    mutationFn: (v: { kind: 'close' | 'cancel'; text: string }) => (v.kind === 'close' ? closeTransfer(transfer.id, v.text) : cancelTransfer(transfer.id, v.text)),
    onSuccess: async () => { toast.success('Done.'); setAction(null); await refresh(); onClose() },
    onError: (e) => setReasonError(toAppError(e).message),
  })

  return (
    <>
      <Modal
        open size="lg" onClose={onClose} title={`${transfer.transfer_number} · ${transfer.from_warehouse?.name} → ${transfer.to_warehouse?.name}`}
        description={`Sent ${formatDateTime(transfer.dispatched_at)}`}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            {canReceive && <Button onClick={() => setAction('receive')} disabled={!lines.data}>Receive goods</Button>}
            {canClose && <Button variant="secondary" onClick={() => { setReasonError(null); setAction('close') }}>Close short…</Button>}
            {canCancel && <Button variant="ghost" onClick={() => { setReasonError(null); setAction('cancel') }}>Cancel transfer</Button>}
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </div>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge tone={TRANSFER_STATUS_TONE[status] ?? 'blue'}>{TRANSFER_STATUS_LABEL[status] ?? status}</Badge>
          {transfer.status_reason && <span className="rounded-md bg-amber-50 px-2 py-1 text-sm text-amber-900">{transfer.status_reason}</span>}
        </div>
        {transfer.notes && <p className="mb-3 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">{transfer.notes}</p>}
        {lines.isPending ? <LoadingState /> : lines.isError ? <ErrorState message={toAppError(lines.error).message} onRetry={() => void lines.refetch()} /> : (lines.data ?? []).length === 0 ? <EmptyState title="No lines visible" /> : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">Transfer lines</caption>
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-2 pr-3">Product</th><th className="pr-3">Batch</th><th className="pr-3">Sent as</th><th className="pr-3 text-right">Sent</th><th className="pr-3 text-right">Arrived</th><th className="text-right">On the way</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {(lines.data ?? []).map((l) => {
                  const left = outstandingBase(l)
                  return (
                    <tr key={l.id}>
                      <td className="py-2 pr-3"><span className="font-medium">{l.product?.brand_name}</span> <span className="font-mono text-xs text-slate-500">{l.product?.sku}</span></td>
                      <td className="pr-3 font-mono text-xs">{l.batch ? `${l.batch.batch_number} · ${l.batch.expiry_date}` : '—'}</td>
                      <td className="pr-3"><StockStatusBadge status={l.source_status} /></td>
                      <td className="pr-3 text-right tabular-nums">{fmtQty(Number(l.dispatched_base))}</td>
                      <td className="pr-3 text-right tabular-nums">{fmtQty(Number(l.received_base))}{Number(l.short_base) > 0 ? <span className="text-amber-700"> (−{fmtQty(Number(l.short_base))} lost)</span> : null}{Number(l.returned_base) > 0 ? <span className="text-slate-500"> (returned)</span> : null}</td>
                      <td className={`text-right tabular-nums ${left > 0 ? 'font-semibold text-blue-700' : 'text-slate-400'}`}>{fmtQty(left)} <span className="text-xs font-normal text-slate-500">{l.product?.base_unit?.name?.toLowerCase()}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
      {action === 'receive' && lines.data && <ReceiveDialog transfer={transfer} lines={lines.data} onClose={() => setAction(null)} onDone={async () => { await refresh() }} />}
      {action === 'close' && (
        <ReasonDialog
          open title="Close short" confirmLabel="Write off the rest" tone="danger" busy={withReason.isPending} error={reasonError}
          description="Whatever has not arrived is written off as lost in transit. Goods already received stay in the receiving warehouse. This cannot be undone."
          onConfirm={(text) => withReason.mutate({ kind: 'close', text })} onClose={() => setAction(null)}
        />
      )}
      {action === 'cancel' && (
        <ReasonDialog
          open title="Cancel this transfer" confirmLabel="Cancel and return the goods" tone="danger" busy={withReason.isPending} error={reasonError}
          description="Nothing has arrived, so the goods go back into the sending warehouse, in the same batch, location and condition."
          onConfirm={(text) => withReason.mutate({ kind: 'cancel', text })} onClose={() => setAction(null)}
        />
      )}
    </>
  )
}

function ReceiveDialog({ transfer, lines, onClose, onDone }: { transfer: StockTransfer; lines: StockTransferLine[]; onClose: () => void; onDone: () => Promise<void> }) {
  const toast = useToast()
  const open = lines.filter((l) => outstandingBase(l) > 0)
  const locations = useQuery({ queryKey: ['location-options', transfer.to_warehouse_id], queryFn: () => listLocationOptions(transfer.to_warehouse_id) })
  const [parts, setParts] = useState<ReceivePart[]>(() => open.map((l) => emptyReceivePart(nextKey(), l.id, '', 1)))
  const [error, setError] = useState<string | null>(null)
  const patch = (key: string, p: Partial<ReceivePart>) => setParts((ps) => ps.map((x) => (x.key === key ? { ...x, ...p } : x)))
  const receive = useMutation({
    mutationFn: (lines: Extract<ReturnType<typeof buildTransferReceipt>, { ok: true }>['lines']) => receiveTransfer(transfer.id, lines),
    onSuccess: async (r) => { toast.success(r.transfer_status === 'RECEIVED' ? 'Everything has arrived.' : 'Booked in - the rest is still on the way.'); await onDone(); onClose() },
    onError: (e) => setError(toAppError(e).message),
  })
  function submit(e: FormEvent) {
    e.preventDefault()
    const built = buildTransferReceipt(parts, lines)
    if (!built.ok) { setError(built.error); return }
    setError(null)
    receive.mutate(built.lines)
  }
  return (
    <Modal
      open size="lg" onClose={onClose} title={`Receive ${transfer.transfer_number}`}
      description={`Into ${transfer.to_warehouse?.name ?? 'the warehouse'}. Enter what actually arrived, in what condition. Leave a line blank if nothing arrived for it yet.`}
      footer={<><Button variant="secondary" onClick={onClose} disabled={receive.isPending}>Cancel</Button><Button type="submit" form="recv-form" loading={receive.isPending}>Book in</Button></>}
    >
      <form id="recv-form" onSubmit={submit} noValidate className="space-y-4">
        <InlineError message={error} />
        {open.map((l) => {
          const mine = parts.filter((p) => p.lineId === l.id)
          const left = outstandingBase(l)
          const unit = l.product?.base_unit?.name?.toLowerCase() ?? 'units'
          return (
            <fieldset key={l.id} className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/50 p-3">
              <legend className="px-1 text-sm font-semibold text-slate-800">{l.product?.brand_name} <span className="font-mono text-xs font-normal text-slate-500">{l.batch ? `batch ${l.batch.batch_number}` : ''}</span></legend>
              <p className="text-xs text-slate-500">{fmtQty(left)} {unit} still on the way</p>
              {mine.map((p) => (
                <div key={p.key} className="grid gap-3 border-t border-slate-200 pt-3 first:border-t-0 first:pt-0 sm:grid-cols-6">
                  <Field label={`Arrived (${unit})`} className="sm:col-span-2">
                    <Input type="number" inputMode="decimal" min="0" step="any" value={p.quantity} onChange={(e) => patch(p.key, { quantity: e.target.value })} />
                  </Field>
                  <Field label="Condition" className="sm:col-span-2">
                    <Select value={p.status} onChange={(e) => patch(p.key, { status: e.target.value as StockStatus })}>
                      {STOCK_STATUSES.map((s) => <option key={s} value={s}>{STOCK_STATUS_LABEL[s]}</option>)}
                    </Select>
                  </Field>
                  <Field label="Put away in" className="sm:col-span-2">
                    <Select value={p.locationId} onChange={(e) => patch(p.key, { locationId: e.target.value })}>
                      <option value="">No specific location</option>
                      {(locations.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
                    </Select>
                  </Field>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => patch(mine[0]!.key, { quantity: String(left) })}>Everything arrived</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setParts((ps) => { const last = ps.filter((x) => x.lineId === l.id).at(-1)!; return [...ps.slice(0, ps.indexOf(last) + 1), emptyReceivePart(nextKey(), l.id, '', 1), ...ps.slice(ps.indexOf(last) + 1)] })}>
                  <Plus className="h-4 w-4" aria-hidden /> Some in another condition
                </Button>
              </div>
            </fieldset>
          )
        })}
      </form>
    </Modal>
  )
}
