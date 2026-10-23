import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, MapPin } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Badge, Button, Card, CardBody, EmptyState, ErrorState, Field, InlineError, Input, LoadingState, PageHeader, Select, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { useAuth } from '@/modules/auth/AuthProvider'
import { ReasonDialog } from '@/modules/purchasing/shared'
import { useSession } from '@/modules/session/SessionProvider'
import { fmtQty } from '@/services/inventory'
import {
  PRIORITY_LABEL, SHORT_REASONS, assignPicker, cancelOrder, claimOrder, confirmLine, getFulfilmentOrder, getPickLines, giveBackOrder, pickerOptions, resetLine, resolveShort,
  type PickListLine, type QueueRow, type ShortReason,
} from '@/services/fulfilment'
import { FulfilmentStatusBadge } from './PickingQueuePage'

export function PickTaskPage() {
  const { id = '' } = useParams()
  const order = useQuery({ queryKey: ['fulfilment-order', id], queryFn: () => getFulfilmentOrder(id), enabled: Boolean(id) })
  if (order.isPending) return <LoadingState />
  if (order.isError) return <ErrorState message={toAppError(order.error).message} onRetry={() => void order.refetch()} />
  if (!order.data) return <EmptyState title="Order not found" action={<Link className="text-sm font-medium text-brand-700 hover:underline" to="/warehouse/picking">Back to picking</Link>} />
  return <TaskView order={order.data} />
}

type Reasoned = { kind: 'reset' | 'resolve' | 'cancel'; lineId?: string; exceptionId?: string } | null

function TaskView({ order }: { order: QueueRow }) {
  const { ability } = useSession()
  const { auth } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const me = auth.status === 'signedIn' ? auth.session.user.id : null
  const [reasoning, setReasoning] = useState<Reasoned>(null)
  const [error, setError] = useState<string | null>(null)
  const lines = useQuery({ queryKey: ['fulfilment-lines', order.id], queryFn: () => getPickLines(order.id), refetchInterval: 20_000 })
  const canWork = ability.can('picking.work', order.branch_id)
  const canAssign = ability.can('picking.assign', order.branch_id)
  const canRelease = ability.can('fulfilment.release', order.branch_id)
  const live = order.status === 'RELEASED' || order.status === 'PICKING'
  const mine = order.picker_id !== null && order.picker_id === me
  const canConfirm = order.status === 'PICKING' && canWork && (mine || canAssign)
  const pickers = useQuery({ queryKey: ['picker-options', order.branch_id], queryFn: () => pickerOptions(order.branch_id), enabled: canAssign && live, staleTime: 60_000 })
  const [assignTo, setAssignTo] = useState('')

  const refresh = () => Promise.all(['fulfilment-order', 'fulfilment-lines', 'fulfilment-queue', 'invoice-fulfilment'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
  const run = useMutation({
    mutationFn: async (v: { kind: string; reason?: string; user?: string | null }) => {
      if (v.kind === 'claim') return claimOrder(order.id)
      if (v.kind === 'giveBack') return giveBackOrder(order.id)
      if (v.kind === 'assign') return assignPicker(order.id, v.user ?? null)
      if (v.kind === 'cancel') return cancelOrder(order.id, v.reason!)
      if (v.kind === 'reset') return resetLine(reasoning!.lineId!, v.reason!)
      if (v.kind === 'resolve') return void (await resolveShort(reasoning!.exceptionId!, v.reason!))
    },
    onSuccess: async (_d, v) => {
      toast.success({ claim: 'Order claimed: you can start picking.', giveBack: 'Order given back.', assign: 'Picker updated.', cancel: 'Order cancelled.', reset: 'Line reset to pending.', resolve: 'Short pick accepted.' }[v.kind] ?? 'Done.')
      setReasoning(null)
      setError(null)
      await refresh()
    },
    onError: (e) => setError(toAppError(e).message),
  })

  const rows = lines.data ?? []
  return (
    <>
      <Link to="/warehouse/picking" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" aria-hidden /> Picking</Link>
      <PageHeader
        title={order.order_number}
        description={`${order.customer_name} · invoice ${order.invoice_number ?? ''} · ${order.warehouse_name}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <FulfilmentStatusBadge status={order.status} />
            {['PICKED', 'PACKING', 'PACKED', 'READY'].includes(order.status) && <Link to={`/warehouse/packing/${order.id}`} className="text-sm font-semibold text-brand-700 hover:underline">Open packing and dispatch →</Link>}
            <Badge tone={order.priority === 1 ? 'red' : 'slate'}>{PRIORITY_LABEL[order.priority]}</Badge>
            {order.required_by && <Badge tone="amber">Needed by {order.required_by}</Badge>}
            {live && canWork && order.picker_id === null && <Button onClick={() => run.mutate({ kind: 'claim' })} loading={run.isPending}>Claim this order</Button>}
            {live && canWork && order.picker_id !== null && !mine && !canAssign && <Badge tone="slate">Picker: {order.picker_name}</Badge>}
            {live && (mine || (canAssign && order.picker_id !== null)) && <Button variant="secondary" onClick={() => run.mutate({ kind: 'giveBack' })} loading={run.isPending}>Give back</Button>}
            {(order.status === 'RELEASED' || order.status === 'PICKING' || order.status === 'PICKED') && canRelease && <Button variant="ghost" onClick={() => { setError(null); setReasoning({ kind: 'cancel' }) }}>Cancel order</Button>}
          </div>
        }
      />
      <InlineError message={reasoning ? null : error} />
      {canAssign && live && (
        <Card className="mb-4">
          <CardBody>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Field label={`Picker${order.picker_name ? ` (now ${order.picker_name})` : ''}`}>
                  <Select value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
                    <option value="">Choose a person…</option>
                    {(pickers.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                </Field>
              </div>
              <Button variant="secondary" disabled={!assignTo} loading={run.isPending} onClick={() => run.mutate({ kind: 'assign', user: assignTo })}>Assign</Button>
            </div>
          </CardBody>
        </Card>
      )}
      {order.status === 'PICKING' && order.open_exceptions > 0 && (
        <p role="status" className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-600/20">A short pick is waiting for a supervisor. The order becomes Picked once every line is confirmed and each short pick has been accepted.</p>
      )}
      {lines.isPending ? <LoadingState /> : lines.isError ? <ErrorState message={toAppError(lines.error).message} onRetry={() => void lines.refetch()} /> : (
        <ol className="space-y-3" aria-label="Pick lines in walking order">
          {rows.map((l) => (
            <LineCard key={l.line_id} line={l} orderId={order.id} canConfirm={canConfirm} canAssign={canAssign} onReset={() => { setError(null); setReasoning({ kind: 'reset', lineId: l.line_id }) }}
              onResolve={() => { setError(null); setReasoning({ kind: 'resolve', exceptionId: l.exception_id! }) }} onDone={refresh} />
          ))}
        </ol>
      )}
      <ReasonDialog
        open={reasoning !== null}
        title={reasoning?.kind === 'cancel' ? 'Cancel this order?' : reasoning?.kind === 'reset' ? 'Reset this line?' : 'Accept the short pick?'}
        description={reasoning?.kind === 'cancel'
          ? 'The invoice and the stock are not affected. The invoice can be released to the warehouse again.'
          : reasoning?.kind === 'reset' ? 'The line goes back to pending so it can be picked again.' : 'The line stays short. The invoice is not changed: raise a credit note in the usual way if the customer is owed one.'}
        confirmLabel={reasoning?.kind === 'cancel' ? 'Cancel order' : reasoning?.kind === 'reset' ? 'Reset line' : 'Accept short pick'}
        tone={reasoning?.kind === 'cancel' ? 'danger' : 'primary'}
        busy={run.isPending}
        error={error}
        onClose={() => { setReasoning(null); setError(null) }}
        onConfirm={(reason) => reasoning && run.mutate({ kind: reasoning.kind, reason })}
      />
    </>
  )
}

function LineCard({ line, canConfirm, canAssign, onReset, onResolve, onDone }: {
  line: PickListLine; orderId: string; canConfirm: boolean; canAssign: boolean; onReset: () => void; onResolve: () => void; onDone: () => Promise<unknown>
}) {
  const toast = useToast()
  const [qty, setQty] = useState(String(line.expected_quantity))
  const [reason, setReason] = useState<ShortReason | ''>('')
  const [note, setNote] = useState('')
  const [batch, setBatch] = useState('')
  const [barcode, setBarcode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const n = Number(qty)
  const short = qty.trim() !== '' && Number.isFinite(n) && n < line.expected_quantity
  const confirm = useMutation({
    mutationFn: () => confirmLine({ lineId: line.line_id, quantity: n, ...(short && reason ? { shortReason: reason } : {}), shortNote: note, scannedBatch: batch, scannedBarcode: barcode }),
    onSuccess: async (r) => { toast.success(r.order_status === 'PICKED' ? 'Line confirmed: the order is fully picked.' : 'Line confirmed.'); setError(null); await onDone() },
    onError: (e) => setError(toAppError(e).message),
  })
  function submit() {
    setError(null)
    if (qty.trim() === '' || !Number.isFinite(n) || n < 0 || n > line.expected_quantity) { setError(`Enter a quantity from 0 to ${fmtQty(line.expected_quantity)}.`); return }
    if (short && !reason) { setError('Say why it is short.'); return }
    confirm.mutate()
  }

  const done = line.status !== 'PENDING'
  return (
    <li>
      <Card>
        <CardBody>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-lg font-semibold text-slate-900"><MapPin className="h-4 w-4 text-slate-400" aria-hidden /> <span>{line.location_code ?? 'No location'}</span></p>
              <p className="mt-1 font-medium text-slate-900">{line.product_name} <span className="font-mono text-xs text-slate-500">{line.sku}</span></p>
              <p className="text-sm text-slate-600">Batch {line.batch_number ?? '—'}{line.expiry_date ? ` · expires ${line.expiry_date}` : ''}</p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-semibold tabular-nums text-slate-900">{fmtQty(line.expected_quantity)} <span className="text-sm font-normal text-slate-500">{line.base_unit}</span></p>
              {line.status === 'PICKED' && <Badge tone="green">Picked</Badge>}
              {line.status === 'SHORT' && <Badge tone="red">Short: {fmtQty(line.picked_quantity ?? 0)} picked</Badge>}
              {line.status === 'PENDING' && <Badge tone="amber">To pick</Badge>}
            </div>
          </div>
          {line.status === 'SHORT' && (
            <p className="mt-2 text-sm text-slate-700">Reason: {SHORT_REASONS.find((r) => r.value === line.short_reason)?.label ?? line.short_reason}{line.short_note ? ` · ${line.short_note}` : ''}{line.exception_status === 'RESOLVED' ? ' · accepted by a supervisor' : ' · waiting for a supervisor'}</p>
          )}
          {done && canAssign && (
            <div className="mt-3 flex flex-wrap gap-2">
              {line.exception_status === 'OPEN' && line.exception_id && <Button size="sm" variant="secondary" onClick={onResolve}>Accept short pick</Button>}
              {line.exception_status !== 'RESOLVED' && <Button size="sm" variant="ghost" onClick={onReset}>Reset line</Button>}
            </div>
          )}
          {!done && canConfirm && (
            <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); submit() }} noValidate>
              <InlineError message={error} />
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Quantity picked"><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
                <Field label="Scan or type batch (optional)"><Input value={batch} onChange={(e) => setBatch(e.target.value)} autoComplete="off" /></Field>
                <Field label="Scan barcode (optional)"><Input value={barcode} onChange={(e) => setBarcode(e.target.value)} autoComplete="off" /></Field>
              </div>
              {short && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Why is it short?" required>
                    <Select value={reason} onChange={(e) => setReason(e.target.value as ShortReason | '')}>
                      <option value="">Choose a reason…</option>
                      {SHORT_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </Select>
                  </Field>
                  <Field label="Note"><Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></Field>
                </div>
              )}
              <Button type="submit" loading={confirm.isPending}>{short ? 'Confirm short pick' : 'Confirm picked'}</Button>
            </form>
          )}
        </CardBody>
      </Card>
    </li>
  )
}
