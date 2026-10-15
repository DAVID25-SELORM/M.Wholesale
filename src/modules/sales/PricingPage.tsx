import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Badge, Button, Card, CardBody, Checkbox, DataTable, EmptyState, ErrorState, Field, InlineError, Input, LoadingState, Modal, PageHeader, Select, StatusBadge, Tabs, useToast, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { ProductPicker } from '@/modules/catalog/ProductPicker'
import { useSession } from '@/modules/session/SessionProvider'
import { listProductUnits, type ProductRow } from '@/services/catalog'
import {
  createPriceList, createPriceListItem, createTaxCode, listPriceListItems, listPriceLists, listTaxCodes, updatePriceList, updatePriceListItem, updateTaxCode,
  type PriceList, type PriceListItemRow, type TaxCode,
} from '@/services/pricing'
import { moneyFmt } from '@/services/sales'

export function PricingPage() {
  const [tab, setTab] = useState('lists')
  return (
    <>
      <PageHeader title="Pricing & tax" description="Price lists decide what each customer pays; tax codes decide the tax on each product." />
      <Tabs label="Pricing sections" value={tab} onChange={setTab} items={[{ id: 'lists', label: 'Price lists' }, { id: 'tax', label: 'Tax codes' }]} />
      <div className="mt-4">{tab === 'lists' ? <PriceListsSection /> : <TaxSection />}</div>
    </>
  )
}

// ---- price lists --------------------------------------------------------------------------------------------------
function PriceListsSection() {
  const { ability } = useSession()
  const canManage = ability.can('pricing.manage')
  const lists = useQuery({ queryKey: ['price-lists'], queryFn: listPriceLists })
  const [selected, setSelected] = useState('')
  const [editing, setEditing] = useState<PriceList | 'new' | null>(null)
  const current = (lists.data ?? []).find((l) => l.id === selected) ?? (lists.data ?? [])[0]

  if (lists.isPending) return <LoadingState />
  if (lists.isError) return <ErrorState message={toAppError(lists.error).message} onRetry={() => void lists.refetch()} />

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Price list" className="w-full sm:w-72">
            <Select value={current?.id ?? ''} onChange={(e) => setSelected(e.target.value)}>
              {(lists.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}{l.is_default ? ' (default)' : ''}{l.is_active ? '' : ' - inactive'}</option>)}
            </Select>
          </Field>
          {current && <Button variant="secondary" onClick={() => setEditing(current)}>{canManage ? 'Edit list' : 'Details'}</Button>}
          {canManage && <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" aria-hidden /> New price list</Button>}
        </CardBody>
      </Card>
      {current ? <PriceListItems list={current} canManage={canManage} /> : <EmptyState title="No price lists yet" description="Create a price list, then add the prices your customers pay." />}
      {editing && <PriceListForm key={editing === 'new' ? 'new' : editing.id} list={editing === 'new' ? null : editing} canManage={canManage} onClose={() => setEditing(null)} onSaved={(id) => setSelected(id)} />}
    </div>
  )
}

function PriceListForm({ list, canManage, onClose, onSaved }: { list: PriceList | null; canManage: boolean; onClose: () => void; onSaved: (id: string) => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [code, setCode] = useState(list?.code ?? '')
  const [name, setName] = useState(list?.name ?? '')
  const [isDefault, setDefault] = useState(list?.is_default ?? false)
  const [isActive, setActive] = useState(list?.is_active ?? true)
  const [notes, setNotes] = useState(list?.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: async () => {
      if (list) { await updatePriceList(list.id, { name, is_default: isDefault, is_active: isActive, notes }); return list.id }
      return createPriceList({ code, name, is_default: isDefault, is_active: isActive, notes })
    },
    onSuccess: async (id) => { toast.success('Price list saved.'); await qc.invalidateQueries({ queryKey: ['price-lists'] }); onSaved(id); onClose() },
    onError: (e) => setError(toAppError(e).message),
  })
  function submit(e: FormEvent) {
    e.preventDefault()
    if (!list && !/^[A-Za-z0-9_-]{1,20}$/.test(code.trim())) { setError('The code is 1–20 letters, digits, "-" or "_".'); return }
    if (!name.trim()) { setError('Enter the name.'); return }
    setError(null)
    save.mutate()
  }
  return (
    <Modal
      open size="md" onClose={onClose} title={list ? 'Price list' : 'New price list'}
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button>{canManage && <Button type="submit" form="pl-form" loading={save.isPending}>Save</Button>}</>}
    >
      <form id="pl-form" onSubmit={submit} noValidate className="space-y-3">
        <InlineError message={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code" required><Input value={code} disabled={Boolean(list) || !canManage} onChange={(e) => setCode(e.target.value)} maxLength={20} /></Field>
          <Field label="Name" required><Input value={name} disabled={!canManage} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
        </div>
        <Field label="Notes"><Input value={notes} disabled={!canManage} onChange={(e) => setNotes(e.target.value)} maxLength={300} /></Field>
        <Checkbox label="Default list (used for customers without their own list)" checked={isDefault} disabled={!canManage} onChange={(e) => setDefault(e.target.checked)} />
        <Checkbox label="Active" checked={isActive} disabled={!canManage} onChange={(e) => setActive(e.target.checked)} />
      </form>
    </Modal>
  )
}

function PriceListItems({ list, canManage }: { list: PriceList; canManage: boolean }) {
  const qc = useQueryClient()
  const toast = useToast()
  const items = useQuery({ queryKey: ['price-list-items', list.id], queryFn: () => listPriceListItems(list.id) })
  const [product, setProduct] = useState<ProductRow | null>(null)
  const [unitId, setUnitId] = useState('')
  const [price, setPrice] = useState('')
  const [error, setError] = useState<string | null>(null)
  const units = useQuery({ queryKey: ['product-units', product?.id], queryFn: () => listProductUnits(product!.id), enabled: Boolean(product) })
  const sellable = (units.data ?? []).filter((u) => u.is_active && u.is_sellable)
  const refresh = () => qc.invalidateQueries({ queryKey: ['price-list-items', list.id] })

  const add = useMutation({
    mutationFn: () => createPriceListItem({ price_list_id: list.id, product_id: product!.id, product_unit_id: unitId || sellable.find((u) => u.is_base)?.id || '', unit_price: Number(price) }),
    onSuccess: async () => { toast.success('Price added.'); setProduct(null); setUnitId(''); setPrice(''); await refresh() },
    onError: (e) => setError(toAppError(e).message),
  })
  const patch = useMutation({
    mutationFn: (v: { id: string; unit_price?: number; is_active?: boolean }) => updatePriceListItem(v.id, { ...(v.unit_price !== undefined ? { unit_price: v.unit_price } : {}), ...(v.is_active !== undefined ? { is_active: v.is_active } : {}) }),
    onSuccess: () => refresh(),
    onError: (e) => toast.error(toAppError(e).message),
  })

  function submitAdd(e: FormEvent) {
    e.preventDefault()
    const n = Number(price)
    if (!product) { setError('Choose the product.'); return }
    if (price.trim() === '' || !Number.isFinite(n) || n < 0 || Math.abs(n - Number(n.toFixed(4))) > 1e-9) { setError('Enter a price of 0 or more with at most 4 decimals.'); return }
    if (!unitId && !sellable.some((u) => u.is_base)) { setError('This product has no sellable base unit; choose a pack.'); return }
    setError(null)
    add.mutate()
  }

  const columns: Column<PriceListItemRow>[] = [
    { key: 'p', header: 'Product', render: (r) => <span><span className="font-medium text-slate-900">{r.product_unit?.product?.brand_name}</span> <span className="text-xs text-slate-500">{r.product_unit?.product?.sku}</span></span> },
    { key: 'u', header: 'Pack', hideOnMobile: true, render: (r) => <span className="text-slate-600">{r.product_unit?.unit?.name}{Number(r.product_unit?.factor_to_base) > 1 ? ` (×${Number(r.product_unit?.factor_to_base)})` : ''}</span> },
    {
      key: 'price', header: 'Price', className: 'text-right',
      render: (r) => canManage
        ? <Input aria-label={`Price for ${r.product_unit?.product?.sku}`} type="number" min="0" step="any" defaultValue={Number(r.unit_price)} className="ml-auto h-8 w-28 text-right"
            onBlur={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= 0 && n !== Number(r.unit_price)) patch.mutate({ id: r.id, unit_price: n }) }} />
        : <span className="tabular-nums">{moneyFmt(r.unit_price)}</span>,
    },
    { key: 'a', header: 'Status', render: (r) => (canManage ? <Button size="sm" variant="ghost" onClick={() => patch.mutate({ id: r.id, is_active: !r.is_active })}>{r.is_active ? 'Active - turn off' : 'Off - turn on'}</Button> : <StatusBadge active={r.is_active} />) },
  ]

  return (
    <Card>
      {canManage && list.is_active && (
        <form onSubmit={submitAdd} noValidate className="space-y-3 border-b border-slate-100 p-4">
          <InlineError message={error} />
          <ProductPicker value={product} onChange={(p) => { setProduct(p); setUnitId('') }} />
          {product && (
            <div className="grid items-end gap-3 sm:grid-cols-4">
              <Field label="Pack">
                <Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                  <option value="">{sellable.find((u) => u.is_base)?.unit?.name ?? 'Base unit'}</option>
                  {sellable.filter((u) => !u.is_base).map((u) => <option key={u.id} value={u.id}>{u.unit?.name} (×{Number(u.factor_to_base)})</option>)}
                </Select>
              </Field>
              <Field label="Price" required><Input type="number" min="0" step="any" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
              <Button type="submit" loading={add.isPending}>Add price</Button>
            </div>
          )}
        </form>
      )}
      <DataTable
        caption={`Prices in ${list.name}`} columns={columns} rows={items.data} rowKey={(r) => r.id} loading={items.isFetching}
        error={items.isError ? toAppError(items.error).message : null} onRetry={() => void items.refetch()}
        emptyTitle="No prices yet" emptyDescription="Add the products this list prices, per pack level."
      />
    </Card>
  )
}

// ---- tax codes ----------------------------------------------------------------------------------------------------
function TaxSection() {
  const { ability } = useSession()
  const canManage = ability.can('pricing.manage')
  const codes = useQuery({ queryKey: ['tax-codes'], queryFn: listTaxCodes })
  const [editing, setEditing] = useState<TaxCode | 'new' | null>(null)

  const columns: Column<TaxCode>[] = [
    { key: 'c', header: 'Code', render: (t) => <span className="font-mono text-xs font-semibold">{t.code}</span> },
    { key: 'n', header: 'Name', render: (t) => <span className="font-medium text-slate-900">{t.name}</span> },
    { key: 'r', header: 'Rate', className: 'text-right', render: (t) => <span className="tabular-nums">{Number(t.rate)}%</span> },
    { key: 's', header: 'Status', render: (t) => <span className="flex gap-1"><StatusBadge active={t.is_active} />{t.is_default && <Badge tone="blue">Default</Badge>}</span> },
    { key: 'e', header: '', className: 'text-right', render: (t) => <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>{canManage ? 'Edit' : 'View'}</Button> },
  ]
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 p-4">
        <p className="text-sm text-slate-600">The default code applies to products without one of their own. Rates are snapshotted on each invoice line.</p>
        {canManage && <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" aria-hidden /> New tax code</Button>}
      </div>
      <DataTable
        caption="Tax codes" columns={columns} rows={codes.data} rowKey={(t) => t.id} loading={codes.isFetching}
        error={codes.isError ? toAppError(codes.error).message : null} onRetry={() => void codes.refetch()} emptyTitle="No tax codes"
      />
      {editing && <TaxForm key={editing === 'new' ? 'new' : editing.id} tax={editing === 'new' ? null : editing} canManage={canManage} onClose={() => setEditing(null)} />}
    </Card>
  )
}

function TaxForm({ tax, canManage, onClose }: { tax: TaxCode | null; canManage: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [code, setCode] = useState(tax?.code ?? '')
  const [name, setName] = useState(tax?.name ?? '')
  const [rate, setRate] = useState(tax ? String(Number(tax.rate)) : '0')
  const [isDefault, setDefault] = useState(tax?.is_default ?? false)
  const [isActive, setActive] = useState(tax?.is_active ?? true)
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: () => {
      const v = { name, rate: Number(rate), is_default: isDefault, is_active: isActive }
      return tax ? updateTaxCode(tax.id, v) : createTaxCode({ code, ...v })
    },
    onSuccess: async () => { toast.success('Tax code saved.'); await qc.invalidateQueries({ queryKey: ['tax-codes'] }); onClose() },
    onError: (e) => setError(toAppError(e).message),
  })
  function submit(e: FormEvent) {
    e.preventDefault()
    const r = Number(rate)
    if (!tax && !/^[A-Za-z0-9_-]{1,20}$/.test(code.trim())) { setError('The code is 1–20 letters, digits, "-" or "_".'); return }
    if (!name.trim()) { setError('Enter the name.'); return }
    if (rate.trim() === '' || !Number.isFinite(r) || r < 0 || r > 100) { setError('The rate must be between 0 and 100 %.'); return }
    setError(null)
    save.mutate()
  }
  return (
    <Modal
      open size="md" onClose={onClose} title={tax ? 'Tax code' : 'New tax code'}
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button>{canManage && <Button type="submit" form="tax-form" loading={save.isPending}>Save</Button>}</>}
    >
      <form id="tax-form" onSubmit={submit} noValidate className="space-y-3">
        <InlineError message={error} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Code" required><Input value={code} disabled={Boolean(tax) || !canManage} onChange={(e) => setCode(e.target.value)} maxLength={20} /></Field>
          <Field label="Name" required><Input value={name} disabled={!canManage} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
          <Field label="Rate %" required><Input type="number" min="0" max="100" step="0.01" value={rate} disabled={!canManage} onChange={(e) => setRate(e.target.value)} /></Field>
        </div>
        <Checkbox label="Default code" checked={isDefault} disabled={!canManage} onChange={(e) => setDefault(e.target.checked)} />
        <Checkbox label="Active" checked={isActive} disabled={!canManage || Boolean(tax?.is_default)} onChange={(e) => setActive(e.target.checked)} />
      </form>
    </Modal>
  )
}
