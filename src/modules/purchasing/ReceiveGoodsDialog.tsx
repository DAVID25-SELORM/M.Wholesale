import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Button, Field, InlineError, Input, Modal, Select, Textarea, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { listProductUnits } from '@/services/catalog'
import { fmtQty, listLocationOptions } from '@/services/inventory'
import {
  RECEIPT_STATUS_LABEL, receiveGoods, remainingPacks, type PurchaseOrder, type PurchaseOrderLine, type ReceiptStatus,
} from '@/services/purchasing'
import { buildReceiveLines, emptyPart, type ReceivePart } from './orderLines'

let seq = 0
const nextKey = () => `r${++seq}`

export function ReceiveGoodsDialog({ order, lines, onClose }: { order: PurchaseOrder | null; lines: PurchaseOrderLine[]; onClose: () => void }) {
  return order ? <Inner key={order.id} order={order} lines={lines} onClose={onClose} /> : null
}

function Inner({ order, lines, onClose }: { order: PurchaseOrder; lines: PurchaseOrderLine[]; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const open = lines.filter((l) => remainingPacks(l) > 0)
  const locations = useQuery({ queryKey: ['location-options', order.warehouse_id], queryFn: () => listLocationOptions(order.warehouse_id) })
  const [parts, setParts] = useState<ReceivePart[]>(() =>
    open.map((l) => emptyPart(nextKey(), { id: l.id, product_unit_id: l.product_unit_id, factor: Number(l.unit?.factor_to_base ?? 1) })))
  const [note, setNote] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  const patch = (key: string, p: Partial<ReceivePart>) => setParts((ps) => ps.map((x) => (x.key === key ? { ...x, ...p } : x)))
  const addBatch = (l: PurchaseOrderLine) =>
    setParts((ps) => {
      const last = ps.filter((x) => x.poLineId === l.id).at(-1)!
      const idx = ps.indexOf(last)
      const fresh = emptyPart(nextKey(), { id: l.id, product_unit_id: last.unitId, factor: last.factor })
      return [...ps.slice(0, idx + 1), fresh, ...ps.slice(idx + 1)]
    })

  const post = useMutation({
    mutationFn: (built: Extract<ReturnType<typeof buildReceiveLines>, { ok: true }>) => receiveGoods(order.id, built.lines, note, notes),
    onSuccess: async (r) => {
      toast.success(`${r.grn_number} posted - stock updated.`)
      await Promise.all(['purchase-orders', 'purchase-order', 'purchase-order-lines', 'goods-receipts', 'stock', 'balances', 'stock-documents', 'expiring']
        .map((k) => qc.invalidateQueries({ queryKey: [k] })))
      onClose()
    },
    onError: (e) => setError(toAppError(e).message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    const built = buildReceiveLines(parts, lines)
    if (!built.ok) { setError(built.error); return }
    setError(null)
    post.mutate(built)
  }

  return (
    <Modal
      open size="lg" onClose={onClose}
      title={`Receive goods - ${order.po_number}`}
      description={`${order.supplier?.name ?? ''} · into ${order.warehouse?.name ?? 'the warehouse'}. Leave a line blank if nothing arrived for it.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={post.isPending}>Cancel</Button>
          <Button type="submit" form="grn-form" loading={post.isPending}>Post receipt</Button>
        </>
      }
    >
      <form id="grn-form" onSubmit={submit} noValidate className="space-y-4">
        <InlineError message={error} />
        {open.map((l) => {
          const mine = parts.filter((p) => p.poLineId === l.id)
          return (
            <fieldset key={l.id} className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/50 p-3">
              <legend className="px-1 text-sm font-semibold text-slate-800">
                {l.product?.brand_name} <span className="font-mono text-xs font-normal text-slate-500">{l.product?.sku}</span>
              </legend>
              <p className="text-xs text-slate-500">
                Ordered {fmtQty(Number(l.quantity_ordered))} {l.unit?.unit?.name?.toLowerCase()} · still expected {fmtQty(remainingPacks(l))}
              </p>
              {mine.map((p, i) => (
                <PartEditor
                  key={p.key} part={p} line={l} first={i === 0} locations={locations.data ?? []}
                  onChange={(x) => patch(p.key, x)}
                  onRemove={mine.length > 1 ? () => setParts((ps) => ps.filter((x) => x.key !== p.key)) : null}
                />
              ))}
              {l.product?.track_batches && (
                <Button type="button" variant="ghost" size="sm" onClick={() => addBatch(l)}><Plus className="h-4 w-4" aria-hidden /> Another batch of this product</Button>
              )}
            </fieldset>
          )
        })}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Supplier delivery note no."><Input value={note} maxLength={120} onChange={(e) => setNote(e.target.value)} /></Field>
          <Field label="Notes"><Textarea rows={1} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
        <p className="text-xs text-slate-500">Receiving posts to stock immediately and cannot be edited afterwards; mistakes are corrected with a stock adjustment.</p>
      </form>
    </Modal>
  )
}

function PartEditor({ part, line, first, locations, onChange, onRemove }: {
  part: ReceivePart
  line: PurchaseOrderLine
  first: boolean
  locations: { id: string; code: string }[]
  onChange: (p: Partial<ReceivePart>) => void
  onRemove: (() => void) | null
}) {
  const units = useQuery({ queryKey: ['product-units', line.product_id], queryFn: () => listProductUnits(line.product_id) })
  const usable = (units.data ?? []).filter((u) => u.is_active)
  const tracked = line.product?.track_batches
  return (
    <div className="grid gap-3 border-t border-slate-200 pt-3 first:border-t-0 first:pt-0 sm:grid-cols-6">
      <Field label="Quantity received" className="sm:col-span-2">
        <Input type="number" inputMode="decimal" min="0" step="any" value={part.quantity} onChange={(e) => onChange({ quantity: e.target.value })} />
      </Field>
      <Field label="In" className="sm:col-span-2">
        <Select value={part.unitId} onChange={(e) => onChange({ unitId: e.target.value, factor: Number(usable.find((u) => u.id === e.target.value)?.factor_to_base ?? part.factor) })}>
          {usable.length === 0 && <option value={part.unitId}>{line.unit?.unit?.name}</option>}
          {usable.map((u) => <option key={u.id} value={u.id}>{u.unit?.name}{u.is_base ? '' : ` (×${Number(u.factor_to_base)})`}</option>)}
        </Select>
      </Field>
      <Field label="Condition" className="sm:col-span-2">
        <Select value={part.status} onChange={(e) => onChange({ status: e.target.value as ReceiptStatus })}>
          {(Object.keys(RECEIPT_STATUS_LABEL) as ReceiptStatus[]).map((s) => <option key={s} value={s}>{RECEIPT_STATUS_LABEL[s]}</option>)}
        </Select>
      </Field>
      {tracked && (
        <>
          <Field label="Batch number" className="sm:col-span-2"><Input value={part.batch} autoComplete="off" onChange={(e) => onChange({ batch: e.target.value })} /></Field>
          <Field label="Expiry date" className="sm:col-span-2"><Input type="date" value={part.expiry} onChange={(e) => onChange({ expiry: e.target.value })} /></Field>
          <Field label="Manufactured" className="sm:col-span-2"><Input type="date" value={part.mfg} onChange={(e) => onChange({ mfg: e.target.value })} /></Field>
        </>
      )}
      <Field label="Put away in" className="sm:col-span-4">
        <Select value={part.locationId} onChange={(e) => onChange({ locationId: e.target.value })}>
          <option value="">No specific location</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}
        </Select>
      </Field>
      {!first && onRemove && <div className="flex items-end sm:col-span-2"><Button type="button" variant="ghost" size="sm" onClick={onRemove}>Remove this batch</Button></div>}
    </div>
  )
}
