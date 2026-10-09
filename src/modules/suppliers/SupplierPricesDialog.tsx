import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Badge, Button, Checkbox, EmptyState, ErrorState, Field, InlineError, Input, LoadingState, Modal, Select, StatusBadge, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { ProductPicker } from '@/modules/catalog/ProductPicker'
import { listProductUnits, type ProductRow } from '@/services/catalog'
import { createSupplierProduct, listSupplierProducts, updateSupplierProduct, type Supplier, type SupplierProductRow } from '@/services/suppliers'

/** Which products a supplier sells, in which pack, at what last known cost. Costs are audited. */
export function SupplierPricesDialog({ supplier, canEdit, onClose }: { supplier: Supplier | null; canEdit: boolean; onClose: () => void }) {
  return supplier ? <Inner supplier={supplier} canEdit={canEdit} onClose={onClose} /> : null
}

const num = (v: string): number | null => (v.trim() === '' ? null : Number(v))

function Inner({ supplier, canEdit, onClose }: { supplier: Supplier; canEdit: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const rows = useQuery({ queryKey: ['supplier-products', supplier.id], queryFn: () => listSupplierProducts(supplier.id) })
  const [product, setProduct] = useState<ProductRow | null>(null)
  const units = useQuery({ queryKey: ['product-units', product?.id], queryFn: () => listProductUnits(product!.id), enabled: Boolean(product) })
  const [unitId, setUnitId] = useState('')
  const [supplierSku, setSupplierSku] = useState('')
  const [supplierName, setSupplierName] = useState('')
  const [cost, setCost] = useState('')
  const [lead, setLead] = useState('')
  const [preferred, setPreferred] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<SupplierProductRow | null>(null)
  const [editCost, setEditCost] = useState('')

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['supplier-products', supplier.id] }), qc.invalidateQueries({ queryKey: ['product-suppliers'] })])

  const add = useMutation({
    mutationFn: () => createSupplierProduct({
      supplier_id: supplier.id, product_id: product!.id, product_unit_id: unitId, supplier_sku: supplierSku, supplier_product_name: supplierName,
      last_cost: num(cost), lead_time_days: num(lead), is_preferred: preferred, is_active: true,
    }),
    onSuccess: async () => {
      toast.success('Added to the price list.')
      setProduct(null); setUnitId(''); setSupplierSku(''); setSupplierName(''); setCost(''); setLead(''); setPreferred(false); setError(null)
      await refresh()
    },
    onError: (e) => setError(toAppError(e).message),
  })

  const update = useMutation({
    mutationFn: (v: { row: SupplierProductRow; patch: Partial<{ last_cost: number | null; is_preferred: boolean; is_active: boolean }> }) =>
      updateSupplierProduct(v.row.id, {
        supplier_sku: v.row.supplier_sku ?? undefined, supplier_product_name: v.row.supplier_product_name ?? undefined,
        last_cost: v.patch.last_cost !== undefined ? v.patch.last_cost : v.row.last_cost, lead_time_days: v.row.lead_time_days,
        min_order_quantity: v.row.min_order_quantity, is_preferred: v.patch.is_preferred ?? v.row.is_preferred, is_active: v.patch.is_active ?? v.row.is_active,
      }),
    onSuccess: async () => { setEditing(null); await refresh() },
    onError: (e) => toast.error(toAppError(e).message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!product) { setError('Choose a product.'); return }
    if (!unitId) { setError('Choose the pack level the supplier sells.'); return }
    const c = num(cost)
    if (c !== null && (!Number.isFinite(c) || c < 0)) { setError('Cost must be 0 or more.'); return }
    const l = num(lead)
    if (l !== null && (!Number.isInteger(l) || l < 0 || l > 365)) { setError('Lead time must be a whole number of days (0–365).'); return }
    setError(null)
    add.mutate()
  }

  return (
    <Modal open title={`Price list — ${supplier.name}`} description={`${supplier.code} · costs in ${supplier.currency_code ?? 'your organization currency'}`} onClose={onClose} size="lg"
      footer={<Button variant="secondary" onClick={onClose}>Done</Button>}>
      <div className="space-y-5">
        {rows.isPending ? <LoadingState /> : rows.isError ? <ErrorState message={toAppError(rows.error).message} onRetry={() => void rows.refetch()} /> : (rows.data ?? []).length === 0 ? (
          <EmptyState title="No products on this price list" description={canEdit ? 'Add the products this supplier sells below.' : undefined} />
        ) : (
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
            {(rows.data ?? []).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium text-slate-900">{r.product_unit?.product?.brand_name}</span>{' '}
                  <span className="font-mono text-xs text-slate-500">{r.product_unit?.product?.sku}</span>
                  <span className="block text-xs text-slate-500">{r.product_unit?.unit?.name}{r.supplier_sku ? ` · their code ${r.supplier_sku}` : ''}{r.supplier_product_name ? ` · “${r.supplier_product_name}”` : ''}{r.lead_time_days !== null ? ` · ${r.lead_time_days} d lead` : ''}</span>
                </span>
                <span className="flex items-center gap-2">
                  {editing?.id === r.id ? (
                    <>
                      <Input aria-label="New cost" type="number" step="any" min="0" className="h-8 w-28" value={editCost} onChange={(e) => setEditCost(e.target.value)} />
                      <Button size="sm" loading={update.isPending} onClick={() => update.mutate({ row: r, patch: { last_cost: num(editCost) } })}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                    </>
                  ) : (
                    <>
                      <span className="tabular-nums text-slate-800">{r.last_cost !== null ? Number(r.last_cost).toFixed(2) : 'No cost'}</span>
                      {r.is_preferred && <Badge tone="green">Preferred</Badge>}
                      <StatusBadge active={r.is_active} />
                      {canEdit && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => { setEditing(r); setEditCost(r.last_cost !== null ? String(r.last_cost) : '') }}>Update cost</Button>
                          <Button size="sm" variant="ghost" onClick={() => update.mutate({ row: r, patch: { is_active: !r.is_active } })}>{r.is_active ? 'Deactivate' : 'Activate'}</Button>
                        </>
                      )}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {canEdit && (
          <form onSubmit={submit} noValidate className="space-y-3 border-t border-slate-100 pt-4">
            <h3 className="text-sm font-semibold text-slate-700">Add a product</h3>
            <InlineError message={error} />
            <ProductPicker value={product} onChange={(p) => { setProduct(p); setUnitId('') }} />
            {product && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Pack level they sell" required>
                  <Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                    <option value="">Select…</option>
                    {(units.data ?? []).filter((u) => u.is_active && u.is_purchasable).map((u) => <option key={u.id} value={u.id}>{u.unit?.name}{u.is_base ? '' : ` (${Number(u.factor_to_base)} base)`}</option>)}
                  </Select>
                </Field>
                <Field label="Cost per pack"><Input type="number" inputMode="decimal" step="any" min="0" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>
                <Field label="Their product code"><Input value={supplierSku} onChange={(e) => setSupplierSku(e.target.value)} /></Field>
                <Field label="Their product name"><Input value={supplierName} onChange={(e) => setSupplierName(e.target.value)} /></Field>
                <Field label="Lead time (days)"><Input type="number" inputMode="numeric" min="0" max="365" value={lead} onChange={(e) => setLead(e.target.value)} /></Field>
                <div className="flex items-end pb-2"><Checkbox label="Preferred supplier for this product" checked={preferred} onChange={(e) => setPreferred(e.target.checked)} /></div>
              </div>
            )}
            <Button type="submit" loading={add.isPending} disabled={!product}>Add to price list</Button>
          </form>
        )}
      </div>
    </Modal>
  )
}
