import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Badge, Button, Card, CardBody, CardHeader, Checkbox, EmptyState, ErrorState, Field, InlineError, Input, LoadingState, PageHeader, Select, StatusBadge, Tabs, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { useSession } from '@/modules/session/SessionProvider'
import {
  PRODUCT_CLASS_LABEL, STORAGE_LABEL, createBarcode, createProductAlias, createProductUnit, getProduct, listBarcodes, listProductAliases, listProductUnits,
  listUnitsOfMeasure, setAliasActive, setBarcodeActive, updateProductUnit, type ProductClass, type ProductDetail,
} from '@/services/catalog'
import { listProductSuppliers } from '@/services/suppliers'
import { ProductForm } from './ProductForm'

export function ProductDetailPage() {
  const { id = '' } = useParams()
  const { ability } = useSession()
  const [tab, setTab] = useState('packaging')
  const [editing, setEditing] = useState(false)
  const query = useQuery({ queryKey: ['product', id], queryFn: () => getProduct(id), enabled: Boolean(id) })

  if (query.isPending) return <LoadingState />
  if (query.isError) return <ErrorState message={toAppError(query.error).message} onRetry={() => void query.refetch()} />
  const p = query.data
  if (!p) return <EmptyState title="Product not found" description="It may belong to another organization or no longer exist." action={<Link className="text-sm font-medium text-brand-700 hover:underline" to="/catalog/products">Back to products</Link>} />

  const canEdit = ability.can('products.edit')
  const tabs = [
    { id: 'packaging', label: 'Packaging & units' },
    { id: 'barcodes', label: 'Barcodes' },
    { id: 'aliases', label: 'Aliases' },
    ...(ability.canAnywhere('suppliers.view') ? [{ id: 'suppliers', label: 'Suppliers' }] : []),
  ]

  return (
    <>
      <Link to="/catalog/products" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" aria-hidden /> Products</Link>
      <PageHeader
        title={p.brand_name}
        description={`${p.sku}${p.identity ? ` · ${p.identity.generic_name} ${p.identity.strength_text} (${p.identity.dosage_form?.name ?? ''})` : ''}`}
        actions={<Button variant="secondary" onClick={() => setEditing(true)}>{canEdit ? 'Edit product' : 'View details'}</Button>}
      />
      <Summary p={p} />
      <div className="mt-5"><Tabs label="Product sections" items={tabs} value={tab} onChange={setTab} /></div>
      <div className="mt-4">
        {tab === 'packaging' && <PackagingTab product={p} canEdit={canEdit} />}
        {tab === 'barcodes' && <BarcodesTab productId={p.id} canEdit={canEdit} />}
        {tab === 'aliases' && <AliasesTab productId={p.id} canEdit={canEdit} />}
        {tab === 'suppliers' && <SuppliersTab productId={p.id} />}
      </div>
      <ProductForm open={editing} product={p} canEdit={canEdit} canCreateIdentity={ability.can('products.create')} onClose={() => setEditing(false)} />
    </>
  )
}

function Summary({ p }: { p: ProductDetail }) {
  const rows: [string, string][] = [
    ['Class', PRODUCT_CLASS_LABEL[p.product_class as ProductClass] ?? p.product_class],
    ['Manufacturer', p.manufacturer?.name ?? '—'],
    ['Category', p.category?.name ?? '—'],
    ['Base unit', p.base_unit?.name ?? '—'],
    ['Storage', STORAGE_LABEL[p.storage_condition as keyof typeof STORAGE_LABEL] ?? p.storage_condition],
    ['FDA registration', p.fda_registration_number ? `${p.fda_registration_number}${p.fda_registration_expiry ? ` (expires ${p.fda_registration_expiry})` : ''}` : '—'],
  ]
  return (
    <Card>
      <CardBody>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <StatusBadge active={p.is_active} />
          {p.requires_prescription && <Badge tone="amber">Prescription</Badge>}
          {p.is_controlled && <Badge tone="red">Controlled</Badge>}
          {p.track_batches && <Badge tone="blue">Batch &amp; expiry tracked</Badge>}
        </div>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(([k, v]) => (
            <div key={k}><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{k}</dt><dd className="mt-0.5 text-sm text-slate-900">{v}</dd></div>
          ))}
        </dl>
        {p.description && <p className="mt-4 text-sm text-slate-600">{p.description}</p>}
      </CardBody>
    </Card>
  )
}

// ---- packaging ------------------------------------------------------------------------------------------------
function PackagingTab({ product, canEdit }: { product: ProductDetail; canEdit: boolean }) {
  const qc = useQueryClient()
  const toast = useToast()
  const units = useQuery({ queryKey: ['product-units', product.id], queryFn: () => listProductUnits(product.id) })
  const allUnits = useQuery({ queryKey: ['units'], queryFn: listUnitsOfMeasure, staleTime: Infinity })
  const [unitId, setUnitId] = useState('')
  const [factor, setFactor] = useState('')
  const [error, setError] = useState<string | null>(null)
  const base = product.base_unit?.name ?? 'base unit'

  const add = useMutation({
    mutationFn: () => createProductUnit({ product_id: product.id, unit_id: unitId, factor_to_base: Number(factor), is_sellable: true, is_purchasable: true }),
    onSuccess: async () => { toast.success('Pack level added.'); setUnitId(''); setFactor(''); setError(null); await qc.invalidateQueries({ queryKey: ['product-units', product.id] }) },
    onError: (e) => setError(toAppError(e).message),
  })
  const toggle = useMutation({
    mutationFn: (v: { id: string; patch: { is_sellable?: boolean; is_purchasable?: boolean; is_active?: boolean } }) => updateProductUnit(v.id, v.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['product-units', product.id] }),
    onError: (e) => toast.error(toAppError(e).message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    const n = Number(factor)
    if (!unitId) { setError('Choose a unit.'); return }
    if (!Number.isFinite(n) || n <= 0) { setError(`Enter how many ${base.toLowerCase()}s are in one (a number greater than 0).`); return }
    setError(null)
    add.mutate()
  }

  const existing = new Set((units.data ?? []).map((u) => u.unit_id))
  return (
    <Card>
      <CardHeader title="Packaging & unit conversions" description={`Everything is counted in the base unit (${base}). Each pack level says how many base units it holds.`} />
      <CardBody className="space-y-4">
        {units.isPending ? <LoadingState /> : units.isError ? <ErrorState message={toAppError(units.error).message} onRetry={() => void units.refetch()} /> : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">Pack levels</caption>
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-2 pr-4">Unit</th><th className="pr-4">Contains</th><th className="pr-4">Sellable</th><th className="pr-4">Purchasable</th><th>Status</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {(units.data ?? []).map((u) => (
                  <tr key={u.id}>
                    <td className="py-2 pr-4 font-medium">{u.unit?.name}{u.is_base && <Badge className="ml-2" tone="blue">Base</Badge>}</td>
                    <td className="pr-4 tabular-nums">{u.is_base ? '—' : `${Number(u.factor_to_base)} ${base.toLowerCase()}${Number(u.factor_to_base) === 1 ? '' : 's'}`}</td>
                    <td className="pr-4"><Checkbox label="" aria-label={`${u.unit?.name} sellable`} checked={u.is_sellable} disabled={!canEdit} onChange={(e) => toggle.mutate({ id: u.id, patch: { is_sellable: e.target.checked } })} /></td>
                    <td className="pr-4"><Checkbox label="" aria-label={`${u.unit?.name} purchasable`} checked={u.is_purchasable} disabled={!canEdit} onChange={(e) => toggle.mutate({ id: u.id, patch: { is_purchasable: e.target.checked } })} /></td>
                    <td>{u.is_base ? <StatusBadge active /> : (
                      canEdit ? <Button size="sm" variant="ghost" onClick={() => toggle.mutate({ id: u.id, patch: { is_active: !u.is_active } })}>{u.is_active ? 'Deactivate' : 'Activate'}</Button> : <StatusBadge active={u.is_active} />
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canEdit && (
          <form onSubmit={submit} noValidate className="space-y-3 border-t border-slate-100 pt-4">
            <h3 className="text-sm font-semibold text-slate-700">Add a pack level</h3>
            <InlineError message={error} />
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <Field label="Unit">
                <Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                  <option value="">Select…</option>
                  {(allUnits.data ?? []).filter((u) => !existing.has(u.id)).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </Select>
              </Field>
              <Field label={`Contains (${base.toLowerCase()}s)`}><Input type="number" inputMode="decimal" min="0" step="any" value={factor} onChange={(e) => setFactor(e.target.value)} /></Field>
              <Button type="submit" loading={add.isPending}>Add</Button>
            </div>
            <p className="text-xs text-slate-500">Conversions cannot be edited later (stock and documents will rely on them). Add a different pack size as a separate product (SKU) if needed.</p>
          </form>
        )}
      </CardBody>
    </Card>
  )
}

// ---- barcodes --------------------------------------------------------------------------------------------------
function BarcodesTab({ productId, canEdit }: { productId: string; canEdit: boolean }) {
  const qc = useQueryClient()
  const toast = useToast()
  const barcodes = useQuery({ queryKey: ['barcodes', productId], queryFn: () => listBarcodes(productId) })
  const units = useQuery({ queryKey: ['product-units', productId], queryFn: () => listProductUnits(productId) })
  const [code, setCode] = useState('')
  const [type, setType] = useState<'GTIN' | 'INTERNAL' | 'SUPPLIER'>('GTIN')
  const [unit, setUnit] = useState('')
  const [error, setError] = useState<string | null>(null)

  const add = useMutation({
    mutationFn: () => createBarcode({ product_id: productId, product_unit_id: unit, barcode: code, barcode_type: type }),
    onSuccess: async () => { toast.success('Barcode added.'); setCode(''); setError(null); await qc.invalidateQueries({ queryKey: ['barcodes', productId] }) },
    onError: (e) => setError(toAppError(e).message),
  })
  const toggle = useMutation({
    mutationFn: (v: { id: string; active: boolean }) => setBarcodeActive(v.id, v.active),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['barcodes', productId] }),
    onError: (e) => toast.error(toAppError(e).message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!/^[0-9A-Za-z._-]{4,64}$/.test(code.trim())) { setError('Enter 4–64 letters, numbers, ".", "-" or "_".'); return }
    if (!unit) { setError('Choose which pack level this barcode scans.'); return }
    setError(null)
    add.mutate()
  }

  return (
    <Card>
      <CardHeader title="Barcodes" description="Each barcode identifies one pack level. GTIN check digits are verified." />
      <CardBody className="space-y-4">
        {barcodes.isPending ? <LoadingState /> : barcodes.isError ? <ErrorState message={toAppError(barcodes.error).message} onRetry={() => void barcodes.refetch()} /> : (barcodes.data ?? []).length === 0 ? (
          <EmptyState title="No barcodes yet" description="Add the manufacturer's GTIN so the product can be scanned." />
        ) : (
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
            {(barcodes.data ?? []).map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0"><span className="font-mono">{b.barcode}</span> <Badge>{b.barcode_type}</Badge> <span className="text-slate-500">{b.product_unit?.unit?.name}</span></span>
                <span className="flex items-center gap-2"><StatusBadge active={b.is_active} />{canEdit && <Button size="sm" variant="ghost" onClick={() => toggle.mutate({ id: b.id, active: !b.is_active })}>{b.is_active ? 'Deactivate' : 'Activate'}</Button>}</span>
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <form onSubmit={submit} noValidate className="space-y-3 border-t border-slate-100 pt-4">
            <InlineError message={error} />
            <div className="grid gap-3 sm:grid-cols-4 sm:items-end">
              <Field label="Barcode" className="sm:col-span-2"><Input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" /></Field>
              <Field label="Type">
                <Select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                  <option value="GTIN">GTIN (EAN/UPC)</option><option value="INTERNAL">Internal</option><option value="SUPPLIER">Supplier</option>
                </Select>
              </Field>
              <Field label="Pack level">
                <Select value={unit} onChange={(e) => setUnit(e.target.value)}>
                  <option value="">Select…</option>
                  {(units.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.unit?.name}</option>)}
                </Select>
              </Field>
            </div>
            <Button type="submit" loading={add.isPending}>Add barcode</Button>
          </form>
        )}
      </CardBody>
    </Card>
  )
}

// ---- aliases ----------------------------------------------------------------------------------------------------
function AliasesTab({ productId, canEdit }: { productId: string; canEdit: boolean }) {
  const qc = useQueryClient()
  const toast = useToast()
  const aliases = useQuery({ queryKey: ['aliases', productId], queryFn: () => listProductAliases(productId) })
  const [alias, setAlias] = useState('')
  const [error, setError] = useState<string | null>(null)

  const add = useMutation({
    mutationFn: () => createProductAlias(productId, alias),
    onSuccess: async () => { toast.success('Alias added.'); setAlias(''); setError(null); await qc.invalidateQueries({ queryKey: ['aliases', productId] }) },
    onError: (e) => setError(toAppError(e).message),
  })
  const toggle = useMutation({
    mutationFn: (v: { id: string; active: boolean }) => setAliasActive(v.id, v.active),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['aliases', productId] }),
    onError: (e) => toast.error(toAppError(e).message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!alias.trim()) { setError('Type the name as people or suppliers write it.'); return }
    setError(null)
    add.mutate()
  }

  return (
    <Card>
      <CardHeader title="Aliases" description="Other names this product goes by — supplier names, shorthand, old brand names. Search and imports use them. Case, punctuation and spacing do not matter." />
      <CardBody className="space-y-4">
        {aliases.isPending ? <LoadingState /> : aliases.isError ? <ErrorState message={toAppError(aliases.error).message} onRetry={() => void aliases.refetch()} /> : (aliases.data ?? []).length === 0 ? (
          <EmptyState title="No aliases yet" description={`Example: “AUGMENTIN 625MG 14'S” for a product named “Augmentin 625”.`} />
        ) : (
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
            {(aliases.data ?? []).map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 truncate">{a.alias} <Badge>{a.source}</Badge></span>
                <span className="flex items-center gap-2"><span className="hidden text-xs text-slate-400 sm:inline">{formatDateTime(a.created_at)}</span>
                  {canEdit && <Button size="sm" variant="ghost" onClick={() => toggle.mutate({ id: a.id, active: !a.is_active })}>{a.is_active ? 'Deactivate' : 'Activate'}</Button>}</span>
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <form onSubmit={submit} noValidate className="space-y-3 border-t border-slate-100 pt-4">
            <InlineError message={error} />
            <div className="flex gap-2"><div className="flex-1"><Input aria-label="New alias" placeholder="Add an alias…" value={alias} onChange={(e) => setAlias(e.target.value)} /></div><Button type="submit" loading={add.isPending}>Add</Button></div>
          </form>
        )}
      </CardBody>
    </Card>
  )
}

// ---- suppliers of this product ----------------------------------------------------------------------------
function SuppliersTab({ productId }: { productId: string }) {
  const rows = useQuery({ queryKey: ['product-suppliers', productId], queryFn: () => listProductSuppliers(productId) })
  return (
    <Card>
      <CardHeader title="Suppliers" description="Who sells this product, in which pack, at what last known cost. Manage prices from each supplier's price list." />
      <CardBody>
        {rows.isPending ? <LoadingState /> : rows.isError ? <ErrorState message={toAppError(rows.error).message} onRetry={() => void rows.refetch()} /> : (rows.data ?? []).length === 0 ? (
          <EmptyState title="No suppliers linked" description="Open a supplier → Price list → Add product." />
        ) : (
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
            {(rows.data ?? []).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span><span className="font-medium">{r.supplier?.name}</span> <span className="text-slate-500">· {r.product_unit?.unit?.name}{r.supplier_sku ? ` · ${r.supplier_sku}` : ''}</span> {r.is_preferred && <Badge tone="green">Preferred</Badge>}</span>
                <span className="tabular-nums text-slate-700">{r.last_cost !== null ? Number(r.last_cost).toFixed(2) : 'No cost yet'}{r.lead_time_days !== null ? ` · ${r.lead_time_days} d lead` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}
