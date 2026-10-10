import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Button, Field, InlineError, Input, Modal, Select, Textarea, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { ProductPicker } from '@/modules/catalog/ProductPicker'
import { useSession } from '@/modules/session/SessionProvider'
import { getProduct, listProductUnits, type ProductRow } from '@/services/catalog'
import {
  ADJUSTMENT_REASONS, DOCUMENT_PERMISSION, DOCUMENT_TYPE_LABEL, STATUS_CHANGE_REASONS, STOCK_STATUSES, STOCK_STATUS_LABEL,
  daysUntil, fmtQty, listLocationOptions, listProductBalances, postStockDocument, type DocumentType, type StockStatus,
} from '@/services/inventory'
import { listWarehouseOptions } from '@/services/warehouses'
import { buildPostLines, emptyLine, takesFromStock, type LineDraft } from './postLines'

const INTRO: Record<DocumentType, string> = {
  OPENING: 'Load the quantities you already hold, by batch and expiry. Use this once per warehouse when you start.',
  ADJUSTMENT: 'Correct stock after a count, or record damage, loss or found stock. A reason is required and the change is audited.',
  TRANSFER: 'Move stock from one warehouse to another. Batch, expiry and status travel with it.',
  STATUS_CHANGE: 'Put stock on hold, release it, or mark it damaged or expired. Only AVAILABLE stock can be sold.',
}

let lineSeq = 0
const nextKey = () => `l${++lineSeq}`

export function StockPostingDialog({ type, onClose }: { type: DocumentType | null; onClose: () => void }) {
  return type ? <Inner key={type} type={type} onClose={onClose} /> : null
}

function Inner({ type, onClose }: { type: DocumentType; onClose: () => void }) {
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const warehouses = useQuery({ queryKey: ['warehouse-options', null], queryFn: () => listWarehouseOptions(null) })
  const [warehouseId, setWarehouseId] = useState('')
  const [toWarehouseId, setToWarehouseId] = useState('')
  const [reason, setReason] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<LineDraft[]>(() => [emptyLine(nextKey())])
  const [error, setError] = useState<string | null>(null)

  const permission = DOCUMENT_PERMISSION[type]
  const sources = (warehouses.data ?? []).filter((w) => w.is_active && ability.can(permission, w.branch_id))
  const targets = (warehouses.data ?? []).filter((w) => w.is_active && w.id !== warehouseId)
  const reasons = type === 'ADJUSTMENT' ? ADJUSTMENT_REASONS : type === 'STATUS_CHANGE' ? STATUS_CHANGE_REASONS : null

  const patch = (key: string, p: Partial<LineDraft>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)))

  const post = useMutation({
    mutationFn: (built: ReturnType<typeof buildPostLines> & { ok: true }) =>
      postStockDocument({
        type, warehouseId, lines: built.lines,
        ...(type === 'TRANSFER' ? { toWarehouseId } : {}),
        ...(reason ? { reasonCode: reason } : {}),
        ...(notes.trim() ? { notes } : {}),
      }),
    onSuccess: async (r) => {
      toast.success(`${DOCUMENT_TYPE_LABEL[type]} ${r.document_number} posted.`)
      await Promise.all(['stock', 'balances', 'expiring', 'stock-documents', 'movements'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
      onClose()
    },
    onError: (e) => setError(toAppError(e).message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!warehouseId) { setError(type === 'TRANSFER' ? 'Choose the warehouse to send from.' : 'Choose the warehouse.'); return }
    if (type === 'TRANSFER' && !toWarehouseId) { setError('Choose the warehouse to send to.'); return }
    if (type === 'ADJUSTMENT' && !reason) { setError('Choose a reason for the adjustment.'); return }
    const built = buildPostLines(type, lines)
    if (!built.ok) { setError(built.error); return }
    setError(null)
    post.mutate(built)
  }

  return (
    <Modal
      open
      size="lg"
      title={DOCUMENT_TYPE_LABEL[type]}
      description={INTRO[type]}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={post.isPending}>Cancel</Button>
          <Button type="submit" form="stock-form" loading={post.isPending}>Post {DOCUMENT_TYPE_LABEL[type].toLowerCase()}</Button>
        </>
      }
    >
      <form id="stock-form" onSubmit={submit} noValidate className="space-y-4">
        <InlineError message={error} />
        {warehouses.isSuccess && sources.length === 0 && (
          <InlineError message="You do not have permission to post this kind of document in any warehouse." />
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={type === 'TRANSFER' ? 'From warehouse' : 'Warehouse'} required>
            <Select value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setLines((ls) => ls.map((l) => ({ ...l, balance: null, locationId: '', toLocationId: '' }))) }}>
              <option value="">Select…</option>
              {sources.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
            </Select>
          </Field>
          {type === 'TRANSFER' && (
            <Field label="To warehouse" required>
              <Select value={toWarehouseId} onChange={(e) => { setToWarehouseId(e.target.value); setLines((ls) => ls.map((l) => ({ ...l, toLocationId: '' }))) }}>
                <option value="">Select…</option>
                {targets.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
              </Select>
            </Field>
          )}
          {reasons && (
            <Field label="Reason" required={type === 'ADJUSTMENT'}>
              <Select value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="">{type === 'ADJUSTMENT' ? 'Select…' : 'No reason'}</option>
                {reasons.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
              </Select>
            </Field>
          )}
        </div>

        <div className="space-y-3">
          {lines.map((l, i) => (
            <LineEditor
              key={l.key} index={i} type={type} line={l} warehouseId={warehouseId} toWarehouseId={toWarehouseId}
              onChange={(p) => patch(l.key, p)} onRemove={lines.length > 1 ? () => setLines((ls) => ls.filter((x) => x.key !== l.key)) : null}
            />
          ))}
          <Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, emptyLine(nextKey())])} disabled={lines.length >= 200}>
            <Plus className="h-4 w-4" aria-hidden /> Add line
          </Button>
        </div>

        <Field label="Notes" hint="Optional - shown on the document and in the audit log.">
          <Textarea rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </form>
    </Modal>
  )
}

function LineEditor({ index, type, line, warehouseId, toWarehouseId, onChange, onRemove }: {
  index: number
  type: DocumentType
  line: LineDraft
  warehouseId: string
  toWarehouseId: string
  onChange: (p: Partial<LineDraft>) => void
  onRemove: (() => void) | null
}) {
  const qc = useQueryClient()
  const pid = line.product?.id
  const fromStock = takesFromStock(type, line)
  const units = useQuery({ queryKey: ['product-units', pid], queryFn: () => listProductUnits(pid!), enabled: Boolean(pid) })
  const balances = useQuery({
    queryKey: ['balances', pid, warehouseId], queryFn: () => listProductBalances(pid!, warehouseId),
    enabled: Boolean(pid && warehouseId && fromStock),
  })
  const srcLocations = useQuery({ queryKey: ['location-options', warehouseId], queryFn: () => listLocationOptions(warehouseId), enabled: Boolean(warehouseId) && !fromStock })
  const destWarehouse = type === 'TRANSFER' ? toWarehouseId : warehouseId
  const destLocations = useQuery({
    queryKey: ['location-options', destWarehouse], queryFn: () => listLocationOptions(destWarehouse),
    enabled: Boolean(destWarehouse) && (type === 'TRANSFER' || type === 'STATUS_CHANGE'),
  })
  const activeUnits = (units.data ?? []).filter((u) => u.is_active)
  const baseName = units.data?.find((u) => u.is_base)?.unit?.name ?? 'base unit'

  async function pick(p: ProductRow | null) {
    if (!p) { onChange({ product: null, unitId: '', factor: 1, balance: null }); return }
    onChange({ product: p, unitId: '', factor: 1, balance: null })
    const detail = await qc.fetchQuery({ queryKey: ['product', p.id], queryFn: () => getProduct(p.id), staleTime: 60_000 })
    onChange({ product: p, tracks: detail?.track_batches ?? true })
  }

  return (
    <fieldset className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/50 p-3">
      <legend className="flex w-full items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <span>Line {index + 1}</span>
        {onRemove && <button type="button" onClick={onRemove} className="inline-flex items-center gap-1 text-slate-500 hover:text-red-600" aria-label={`Remove line ${index + 1}`}><Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove</button>}
      </legend>
      <ProductPicker value={line.product} onChange={(p) => void pick(p)} />

      {line.product && (
        <div className="grid gap-3 sm:grid-cols-6">
          {type === 'ADJUSTMENT' && (
            <Field label="Change" className="sm:col-span-6">
              <Select value={line.direction} onChange={(e) => onChange({ direction: e.target.value as 'IN' | 'OUT', balance: null })}>
                <option value="IN">Add stock (found / count up)</option>
                <option value="OUT">Remove stock (loss / count down)</option>
              </Select>
            </Field>
          )}
          <Field label="Quantity" required className="sm:col-span-2">
            <Input type="number" inputMode="decimal" min="0" step="any" value={line.quantity} onChange={(e) => onChange({ quantity: e.target.value })} />
          </Field>
          <Field label="In" className="sm:col-span-2" hint={line.factor !== 1 && Number(line.quantity) > 0 ? `= ${fmtQty(Number(line.quantity) * line.factor)} ${baseName.toLowerCase()}` : undefined}>
            <Select value={line.unitId} onChange={(e) => { const u = activeUnits.find((x) => x.id === e.target.value); onChange({ unitId: e.target.value, factor: u ? Number(u.factor_to_base) : 1 }) }}>
              <option value="">{baseName}</option>
              {activeUnits.filter((u) => !u.is_base).map((u) => <option key={u.id} value={u.id}>{u.unit?.name} (×{Number(u.factor_to_base)})</option>)}
            </Select>
          </Field>

          {fromStock ? (
            <Field label="Take from" required className="sm:col-span-6">
              <Select
                value={line.balance?.id ?? ''}
                disabled={!warehouseId}
                onChange={(e) => onChange({ balance: balances.data?.find((b) => b.id === e.target.value) ?? null })}
              >
                <option value="">{!warehouseId ? 'Choose the warehouse first' : balances.isFetching ? 'Loading stock…' : (balances.data ?? []).length === 0 ? 'No stock of this product here' : 'Select batch…'}</option>
                {(balances.data ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {[b.batch ? `Batch ${b.batch.batch_number} (exp ${b.batch.expiry_date}${daysUntil(b.batch.expiry_date) < 0 ? ', EXPIRED' : ''})` : 'No batch', STOCK_STATUS_LABEL[b.stock_status], b.location ? `Loc ${b.location.code}` : null, `${fmtQty(b.quantity)} on hand`].filter(Boolean).join(' · ')}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <>
              {line.tracks && (
                <>
                  <Field label="Batch number" required className="sm:col-span-2"><Input value={line.batchNumber} onChange={(e) => onChange({ batchNumber: e.target.value })} autoComplete="off" /></Field>
                  <Field label="Expiry date" required className="sm:col-span-2"><Input type="date" value={line.expiry} onChange={(e) => onChange({ expiry: e.target.value })} /></Field>
                  <Field label="Manufactured" className="sm:col-span-2"><Input type="date" value={line.mfg} onChange={(e) => onChange({ mfg: e.target.value })} /></Field>
                </>
              )}
              <Field label="Location" className="sm:col-span-3">
                <Select value={line.locationId} onChange={(e) => onChange({ locationId: e.target.value })}>
                  <option value="">No specific location</option>
                  {(srcLocations.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}
                </Select>
              </Field>
              <Field label="Status" className="sm:col-span-3">
                <Select value={line.status} onChange={(e) => onChange({ status: e.target.value as StockStatus })}>
                  {STOCK_STATUSES.map((s) => <option key={s} value={s}>{STOCK_STATUS_LABEL[s]}</option>)}
                </Select>
              </Field>
            </>
          )}

          {type === 'STATUS_CHANGE' && (
            <Field label="New status" required className="sm:col-span-3">
              <Select value={line.toStatus} onChange={(e) => onChange({ toStatus: e.target.value as StockStatus })}>
                {STOCK_STATUSES.map((s) => <option key={s} value={s}>{STOCK_STATUS_LABEL[s]}</option>)}
              </Select>
            </Field>
          )}
          {(type === 'TRANSFER' || type === 'STATUS_CHANGE') && (
            <Field label={type === 'TRANSFER' ? 'Put away in (destination)' : 'Move to location'} className="sm:col-span-3">
              <Select value={line.toLocationId} onChange={(e) => onChange({ toLocationId: e.target.value })} disabled={!destWarehouse}>
                <option value="">{type === 'STATUS_CHANGE' ? 'Keep current location' : 'No specific location'}</option>
                {(destLocations.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}
              </Select>
            </Field>
          )}
        </div>
      )}
    </fieldset>
  )
}
