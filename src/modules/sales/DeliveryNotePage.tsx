import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, FileDown, Printer } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button, Card, CardBody, CardHeader, EmptyState, ErrorState, Field, InlineError, Input, LoadingState, Modal, PageHeader, Textarea, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { ReasonDialog } from '@/modules/purchasing/shared'
import { useSession } from '@/modules/session/SessionProvider'
import { cancelDeliveryNote, confirmDelivery, dispatchDeliveryNote, failDelivery, getDeliveryNote, getPickList, type DeliveryNote } from '@/services/deliveries'
import { fmtQty } from '@/services/inventory'
import { getOrganization } from '@/services/organization'
import { downloadDeliveryNotePdf } from './documentPdf'
import { DeliveryStatusBadge } from './DeliveriesPage'

type Dialog = 'dispatch' | 'confirm' | 'fail' | 'cancel' | null

export function DeliveryNotePage() {
  const { id = '' } = useParams()
  const note = useQuery({ queryKey: ['delivery-note', id], queryFn: () => getDeliveryNote(id), enabled: Boolean(id) })
  if (note.isPending) return <LoadingState />
  if (note.isError) return <ErrorState message={toAppError(note.error).message} onRetry={() => void note.refetch()} />
  if (!note.data) return <EmptyState title="Delivery note not found" action={<Link className="text-sm font-medium text-brand-700 hover:underline" to="/sales/deliveries">Back to deliveries</Link>} />
  return <NoteView note={note.data} />
}

function NoteView({ note }: { note: DeliveryNote }) {
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const [dialog, setDialog] = useState<Dialog>(null)
  const [error, setError] = useState<string | null>(null)
  const pick = useQuery({ queryKey: ['delivery-pick', note.id], queryFn: () => getPickList(note.id) })
  const org = useQuery({ queryKey: ['organization'], queryFn: getOrganization, staleTime: 5 * 60_000 })
  const o = org.data
  const refresh = () => Promise.all(['delivery-note', 'delivery-notes', 'invoice-delivery', 'dashboard'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
  const can = (p: string) => ability.can(p, note.branch_id)

  const act = useMutation({
    mutationFn: async (v: { kind: Exclude<Dialog, null>; a: string; b?: string }) => {
      if (v.kind === 'dispatch') return dispatchDeliveryNote(note.id, v.a, v.b)
      if (v.kind === 'confirm') return confirmDelivery(note.id, v.a, v.b)
      if (v.kind === 'fail') return failDelivery(note.id, v.a)
      return cancelDeliveryNote(note.id, v.a)
    },
    onSuccess: async (_d, v) => {
      toast.success({ dispatch: 'Dispatched: the goods are on the road.', confirm: 'Delivery confirmed.', fail: 'Recorded as a failed delivery.', cancel: 'Delivery note cancelled.' }[v.kind])
      setDialog(null)
      await refresh()
    },
    onError: (e) => setError(toAppError(e).message),
  })
  const lines = pick.data ?? []
  const pdf = async () => {
    try { await downloadDeliveryNotePdf({ note, lines, org: o }) } catch (e) { toast.error(toAppError(e).message) }
  }

  return (
    <>
      <div className="print-hidden">
        <Link to="/sales/deliveries" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" aria-hidden /> Deliveries</Link>
        <PageHeader
          title={note.note_number}
          description={`${note.customer?.name ?? ''} · invoice ${note.invoice?.invoice_number ?? ''} · from ${note.warehouse?.name ?? ''}`}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <DeliveryStatusBadge status={note.status} />
              {note.status === 'PREPARED' && can('deliveries.dispatch') && <Button onClick={() => { setError(null); setDialog('dispatch') }}>Dispatch</Button>}
              {note.status === 'DISPATCHED' && can('deliveries.dispatch') && <Button onClick={() => { setError(null); setDialog('confirm') }}>Confirm delivery</Button>}
              {note.status === 'DISPATCHED' && can('deliveries.dispatch') && <Button variant="secondary" onClick={() => { setError(null); setDialog('fail') }}>Delivery failed</Button>}
              {note.status === 'PREPARED' && can('deliveries.create') && <Button variant="ghost" onClick={() => { setError(null); setDialog('cancel') }}>Cancel</Button>}
              <Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" aria-hidden /> Print</Button>
              <Button variant="secondary" onClick={() => void pdf()}><FileDown className="h-4 w-4" aria-hidden /> PDF</Button>
            </div>
          }
        />
        {note.status_reason && <p className="mb-4 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">{note.status === 'DELIVERED' ? 'Note: ' : `${note.status === 'FAILED' ? 'Failed' : 'Cancelled'}: `}{note.status_reason}</p>}
      </div>

      <div id="print-area" className="rounded-xl border border-slate-200 bg-white">
        <div className="space-y-5 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-lg font-semibold text-slate-900">{o?.legal_name || o?.name || ''}</p>
              <p className="text-sm text-slate-600">{[o?.address, o?.city, o?.region].filter(Boolean).join(', ')}</p>
              <p className="text-sm text-slate-600">{[o?.phone, o?.email].filter(Boolean).join(' · ')}</p>
            </div>
            <div className="text-right">
              <p className="text-xl font-bold tracking-wide text-slate-900">DELIVERY NOTE</p>
              <p className="font-mono text-sm font-semibold">{note.note_number}</p>
              <p className="text-sm text-slate-600">Invoice {note.invoice?.invoice_number}</p>
              <p className="text-sm text-slate-600">Prepared {formatDateTime(note.prepared_at)}</p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Deliver to</p>
              <p className="font-medium text-slate-900">{note.customer?.name}</p>
              <p className="text-sm text-slate-600">{note.delivery_address}</p>
              <p className="text-sm text-slate-600">{[note.contact_name, note.contact_phone].filter(Boolean).join(' · ')}</p>
            </div>
            <div className="text-sm text-slate-600 sm:text-right">
              <p>Packages: <strong className="text-slate-900">{note.packages}</strong></p>
              {note.driver_name && <p>Driver: {note.driver_name}{note.vehicle_number ? ` · ${note.vehicle_number}` : ''}</p>}
              {note.dispatched_at && <p>Dispatched {formatDateTime(note.dispatched_at)}</p>}
              {note.notes && <p>{note.notes}</p>}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">Pick list</caption>
              <thead className="border-b border-slate-300 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="py-2 pr-3">Location</th><th className="pr-3">Item</th><th className="pr-3">Batch</th><th className="pr-3">Expiry</th><th className="pr-3 text-right">Pick</th><th className="text-right">Ordered</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pick.isPending && <tr><td colSpan={6} className="py-3 text-slate-500">Loading…</td></tr>}
                {lines.map((l, i) => (
                  <tr key={i} className="align-top">
                    <td className="py-2 pr-3 font-mono text-xs font-semibold">{l.location_code ?? '—'}</td>
                    <td className="pr-3"><span className="font-medium text-slate-900">{l.product_name}</span> <span className="text-xs text-slate-500">{l.sku}</span></td>
                    <td className="pr-3 font-mono text-xs">{l.batch_number ?? '—'}</td>
                    <td className="whitespace-nowrap pr-3">{l.expiry_date ?? '—'}</td>
                    <td className="whitespace-nowrap pr-3 text-right tabular-nums font-medium">{fmtQty(l.base_quantity)} {l.base_unit}</td>
                    <td className="whitespace-nowrap text-right tabular-nums text-slate-500">{fmtQty(l.line_quantity)} {l.line_unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-6 pt-6 text-sm text-slate-600 sm:grid-cols-3">
            <p>Picked by: ____________________</p>
            <p>Received by: {note.received_by_name ?? '____________________'}</p>
            <p>Signature / date: ____________________</p>
          </div>
        </div>
      </div>

      {note.delivered_at && (
        <div className="print-hidden mt-5">
          <Card>
            <CardHeader title="Proof of delivery" />
            <CardBody className="text-sm text-slate-700">Received by <strong>{note.received_by_name}</strong> on {formatDateTime(note.delivered_at)}.</CardBody>
          </Card>
        </div>
      )}

      {(dialog === 'dispatch' || dialog === 'confirm') && (
        <TwoFieldDialog
          kind={dialog} busy={act.isPending} error={error} onClose={() => setDialog(null)}
          onSubmit={(a, b) => { setError(null); act.mutate({ kind: dialog, a, ...(b ? { b } : {}) }) }}
        />
      )}
      <ReasonDialog
        open={dialog === 'fail' || dialog === 'cancel'} title={dialog === 'fail' ? 'Delivery failed' : 'Cancel this delivery note'} confirmLabel={dialog === 'fail' ? 'Record failure' : 'Cancel delivery note'} tone="danger"
        description={dialog === 'fail' ? 'The goods did not reach the customer (shop closed, refused ...). The invoice stays; a new delivery note can be prepared.' : 'Nothing has left the warehouse. A new delivery note can be prepared for the invoice.'}
        busy={act.isPending} error={error} onConfirm={(r) => { setError(null); act.mutate({ kind: dialog === 'fail' ? 'fail' : 'cancel', a: r }) }} onClose={() => setDialog(null)}
      />
    </>
  )
}

function TwoFieldDialog({ kind, busy, error, onClose, onSubmit }: { kind: 'dispatch' | 'confirm'; busy: boolean; error: string | null; onClose: () => void; onSubmit: (a: string, b: string) => void }) {
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [local, setLocal] = useState<string | null>(null)
  const dispatch = kind === 'dispatch'
  function submit(e: FormEvent) {
    e.preventDefault()
    if (!a.trim()) { setLocal(dispatch ? 'Enter the driver’s name.' : 'Enter the name of the person who received the goods.'); return }
    setLocal(null)
    onSubmit(a.trim(), b.trim())
  }
  return (
    <Modal
      open size="md" onClose={onClose} title={dispatch ? 'Dispatch the goods' : 'Confirm delivery'}
      description={dispatch ? 'Hand the packages to the driver. From here the invoice can no longer be reversed, only credited.' : 'Record who received the goods: this is the proof of delivery.'}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Back</Button><Button type="submit" form="delivery-form" loading={busy}>{dispatch ? 'Dispatch' : 'Confirm delivery'}</Button></>}
    >
      <form id="delivery-form" onSubmit={submit} noValidate className="space-y-3">
        <InlineError message={local ?? error} />
        <Field label={dispatch ? 'Driver' : 'Received by'} required><Input value={a} maxLength={120} onChange={(e) => setA(e.target.value)} autoFocus /></Field>
        {dispatch
          ? <Field label="Vehicle number"><Input value={b} maxLength={40} onChange={(e) => setB(e.target.value)} /></Field>
          : <Field label="Notes (shortages, damaged cartons ...)"><Textarea rows={3} maxLength={500} value={b} onChange={(e) => setB(e.target.value)} /></Field>}
      </form>
    </Modal>
  )
}
