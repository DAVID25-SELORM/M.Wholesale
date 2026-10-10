import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Button, Field, InlineError, Input, Modal, Select, Textarea, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { ProductPicker } from '@/modules/catalog/ProductPicker'
import { useSession } from '@/modules/session/SessionProvider'
import { listProductUnits, type ProductRow } from '@/services/catalog'
import { listSupplierOptions, listSupplierProducts } from '@/services/suppliers'
import { listWarehouseOptions } from '@/services/warehouses'
import { money, savePurchaseOrder, type PurchaseOrder, type PurchaseOrderLine } from '@/services/purchasing'
import { buildOrderLines, emptyOrderLine, type OrderLineDraft } from './orderLines'

let seq = 0
const nextKey = () => `o${++seq}`

const asProduct = (l: PurchaseOrderLine): ProductRow => ({
  id: l.product_id, sku: l.product?.sku ?? '', brand_name: l.product?.brand_name ?? '', generic_name: null, strength_text: null,
  dosage_form: null, manufacturer_name: null, product_class: '', is_active: true,
})

export function PurchaseOrderForm({ open, order, lines, onClose, onSaved }: {
  open: boolean
  order: PurchaseOrder | null
  lines: PurchaseOrderLine[] | null
  onClose: () => void
  onSaved: (id: string) => void
}) {
  // remount on open so every opening starts from the right state
  return open ? <Inner key={order?.id ?? 'new'} order={order} lines={lines} onClose={onClose} onSaved={onSaved} /> : null
}

function Inner({ order, lines, onClose, onSaved }: { order: PurchaseOrder | null; lines: PurchaseOrderLine[] | null; onClose: () => void; onSaved: (id: string) => void }) {
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const suppliers = useQuery({ queryKey: ['supplier-options'], queryFn: listSupplierOptions, staleTime: 60_000 })
  const warehouses = useQuery({ queryKey: ['warehouse-options', null], queryFn: () => listWarehouseOptions(null), staleTime: 60_000 })

  const [supplierId, setSupplierId] = useState(order?.supplier_id ?? '')
  const [warehouseId, setWarehouseId] = useState(order?.warehouse_id ?? '')
  const [expected, setExpected] = useState(order?.expected_date ?? '')
  const [terms, setTerms] = useState(order ? String(order.payment_terms_days) : '')
  const [notes, setNotes] = useState(order?.notes ?? '')
  const [rows, setRows] = useState<OrderLineDraft[]>(() =>
    lines && lines.length > 0
      ? lines.map((l) => ({ key: nextKey(), product: asProduct(l), unitId: l.product_unit_id, quantity: String(Number(l.quantity_ordered)), cost: String(Number(l.unit_cost)) }))
      : [emptyOrderLine(nextKey())])
  const [error, setError] = useState<string | null>(null)

  const prices = useQuery({ queryKey: ['supplier-products', supplierId], queryFn: () => listSupplierProducts(supplierId), enabled: Boolean(supplierId) })
  const supplier = suppliers.data?.find((s) => s.id === supplierId)
  const delivers = (warehouses.data ?? []).filter((w) => (w.is_active || w.id === order?.warehouse_id) && ability.can('purchasing.create', w.branch_id))
  const built = buildOrderLines(rows)
  const patch = (key: string, p: Partial<OrderLineDraft>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))

  const save = useMutation({
    mutationFn: (lines: Extract<typeof built, { ok: true }>['lines']) =>
      savePurchaseOrder({
        id: order?.id ?? null, supplierId, warehouseId, expectedDate: expected, notes, lines,
        ...(terms.trim() !== '' ? { paymentTermsDays: Number(terms) } : {}),
      }),
    onSuccess: async (id) => {
      toast.success(order ? 'Order saved.' : 'Draft order created.')
      await Promise.all([qc.invalidateQueries({ queryKey: ['purchase-orders'] }), qc.invalidateQueries({ queryKey: ['purchase-order', id] })])
      onSaved(id)
      onClose()
    },
    onError: (e) => setError(toAppError(e).message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!supplierId) { setError('Choose a supplier.'); return }
    if (!warehouseId) { setError('Choose the warehouse it will be delivered to.'); return }
    if (terms.trim() !== '' && (!Number.isInteger(Number(terms)) || Number(terms) < 0 || Number(terms) > 365)) { setError('Payment terms must be a whole number of days (0–365).'); return }
    if (!built.ok) { setError(built.error); return }
    setError(null)
    save.mutate(built.lines)
  }

  return (
    <Modal
      open size="lg" onClose={onClose}
      title={order ? `Edit ${order.po_number}` : 'New purchase order'}
      description="Costs are per pack, before tax. The order is a draft until you submit it for approval."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button type="submit" form="po-form" loading={save.isPending}>{order ? 'Save changes' : 'Save draft'}</Button>
        </>
      }
    >
      <form id="po-form" onSubmit={submit} noValidate className="space-y-4">
        <InlineError message={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Supplier" required>
            <Select value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setTerms('') }}>
              <option value="">Select…</option>
              {(suppliers.data ?? []).filter((s) => s.is_active || s.id === order?.supplier_id).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
            </Select>
          </Field>
          <Field label="Deliver to warehouse" required>
            <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">Select…</option>
              {delivers.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
            </Select>
          </Field>
          <Field label="Expected delivery"><Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
          <Field label="Payment terms (days)" hint={supplier ? 'Leave blank to use the supplier’s terms.' : undefined}>
            <Input type="number" inputMode="numeric" min="0" max="365" value={terms} onChange={(e) => setTerms(e.target.value)} />
          </Field>
        </div>

        <div className="space-y-3">
          {rows.map((r, i) => (
            <LineEditor
              key={r.key} index={i} row={r} supplierPrices={prices.data ?? []}
              onChange={(p) => patch(r.key, p)} onRemove={rows.length > 1 ? () => setRows((rs) => rs.filter((x) => x.key !== r.key)) : null}
            />
          ))}
          <div className="flex items-center justify-between">
            <Button type="button" variant="secondary" size="sm" onClick={() => setRows((rs) => [...rs, emptyOrderLine(nextKey())])} disabled={rows.length >= 100}>
              <Plus className="h-4 w-4" aria-hidden /> Add line
            </Button>
            <p className="text-sm font-semibold text-slate-800">Total {built.ok ? (order ? money(built.total, order.currency_code) : built.total.toFixed(2)) : '—'} <span className="font-normal text-slate-500">before tax</span></p>
          </div>
        </div>

        <Field label="Notes" hint="Optional - visible to everyone who can see the order.">
          <Textarea rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </form>
    </Modal>
  )
}

function LineEditor({ index, row, supplierPrices, onChange, onRemove }: {
  index: number
  row: OrderLineDraft
  supplierPrices: { product_id: string; product_unit_id: string; last_cost: number | null }[]
  onChange: (p: Partial<OrderLineDraft>) => void
  onRemove: (() => void) | null
}) {
  const pid = row.product?.id
  const units = useQuery({ queryKey: ['product-units', pid], queryFn: () => listProductUnits(pid!), enabled: Boolean(pid) })
  const usable = (units.data ?? []).filter((u) => u.is_active && u.is_purchasable)
  const base = usable.find((u) => u.is_base)
  const qty = Number(row.quantity)
  const cost = Number(row.cost)
  const lineTotal = Number.isFinite(qty) && Number.isFinite(cost) && row.quantity && row.cost ? Math.round(qty * cost * 100) / 100 : null

  function pick(p: ProductRow | null) {
    if (!p) { onChange({ product: null, unitId: '', cost: '' }); return }
    // pre-fill the pack level and last known cost from the supplier's price list
    const listed = supplierPrices.find((s) => s.product_id === p.id)
    onChange({ product: p, unitId: listed?.product_unit_id ?? '', cost: listed?.last_cost != null ? String(Number(listed.last_cost)) : '' })
  }

  return (
    <fieldset className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/50 p-3">
      <legend className="flex w-full items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <span>Line {index + 1}</span>
        {onRemove && <button type="button" onClick={onRemove} className="inline-flex items-center gap-1 text-slate-500 hover:text-red-600" aria-label={`Remove line ${index + 1}`}><Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove</button>}
      </legend>
      <ProductPicker value={row.product} onChange={pick} />
      {row.product && (
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Pack level" className="sm:col-span-1">
            <Select value={row.unitId} onChange={(e) => onChange({ unitId: e.target.value })}>
              {base && <option value="">{base.unit?.name}</option>}
              {usable.filter((u) => !u.is_base).map((u) => <option key={u.id} value={u.id}>{u.unit?.name} (×{Number(u.factor_to_base)})</option>)}
            </Select>
          </Field>
          <Field label="Quantity" required><Input type="number" inputMode="decimal" min="0" step="any" value={row.quantity} onChange={(e) => onChange({ quantity: e.target.value })} /></Field>
          <Field label="Cost per pack" required><Input type="number" inputMode="decimal" min="0" step="any" value={row.cost} onChange={(e) => onChange({ cost: e.target.value })} /></Field>
          <div className="flex items-end pb-2 text-sm font-medium tabular-nums text-slate-700">{lineTotal !== null ? lineTotal.toFixed(2) : '—'}</div>
        </div>
      )}
    </fieldset>
  )
}
