import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { Button, Card, CardBody, Field, Input, Select, Textarea, PageHeader, InlineError } from '@/components/ui'
import { useSession } from '@/modules/session/SessionProvider'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/services/common'
import { toAppError } from '@/lib/errors'
import { listSupplierOptions } from '@/services/suppliers'
import { listWarehouseOptions } from '@/services/warehouses'
import { requestProducts } from '@/services/purchaseRequests'
import type { Json } from '@/types/database'

export function SupplierQuotationsPage() {
  const { selectedBranch } = useSession()
  return <Quotations key={selectedBranch} />
}
function Quotations() {
  const { selectedBranch, ability } = useSession()
  const qc = useQueryClient(); const navigate = useNavigate()
  const [page, setPage] = useState(0)
  const [supplier, setSupplier] = useState(''); const [warehouse, setWarehouse] = useState('')
  const [reference, setReference] = useState(''); const [validUntil, setValidUntil] = useState(''); const [notes, setNotes] = useState('')
  const [search, setSearch] = useState(''); const [product, setProduct] = useState(''); const [quantity, setQuantity] = useState('1'); const [cost, setCost] = useState('')
  const [lines, setLines] = useState<{ product_id: string; quantity: number; unit_cost: number; label: string }[]>([])
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null)
  const suppliers = useQuery({ queryKey: ['supplier-options'], queryFn: listSupplierOptions })
  const warehouses = useQuery({ queryKey: ['warehouse-options', selectedBranch], queryFn: () => listWarehouseOptions(selectedBranch === 'ALL' ? null : selectedBranch) })
  const products = useQuery({ queryKey: ['request-products', search], queryFn: () => requestProducts(search), enabled: ability.canAnywhere('purchasing.create') })
  const query = useQuery({ queryKey: ['supplier-quotations', selectedBranch, page], queryFn: async () => {
    let q = supabase.from('supplier_quotations').select('*').order('created_at', { ascending: false }).order('id').range(page * 25, page * 25 + 24)
    if (selectedBranch !== 'ALL') q = q.eq('branch_id', selectedBranch)
    const rows = unwrap(await q, 'supplierQuotations.list')
    const ids = [...new Set(rows.flatMap(row => Array.isArray(row.lines) ? row.lines.flatMap(line => line && typeof line === 'object' && !Array.isArray(line) && typeof line.product_id === 'string' ? [line.product_id] : []) : []))]
    if (!ids.length) return rows
    const names = unwrap(await supabase.from('products').select('id,sku,brand_name').in('id', ids), 'supplierQuotations.products')
    const labels = new Map(names.map(p => [p.id, `${p.sku} / ${p.brand_name}`]))
    return rows.map(row => ({ ...row, lines: (Array.isArray(row.lines) ? row.lines.map(line => line && typeof line === 'object' && !Array.isArray(line) ? { ...line, label: labels.get(String(line.product_id)) ?? 'Product unavailable' } : line) : row.lines) as Json }))
  } })
  async function act(fn: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(null)
    try { await fn(); await qc.invalidateQueries({ queryKey: ['supplier-quotations'] }) } catch (e) { setError(toAppError(e).message) } finally { setBusy(false) }
  }
  return <div className="space-y-4">
    <PageHeader title="Supplier quotations" description="Capture supplier offers in base units. Convert an unexpired offer into a draft purchase order for review and approval." />
    <InlineError message={error} />
    <InlineError message={[suppliers, warehouses, products, query].find(q => q.isError)?.error ? toAppError([suppliers, warehouses, products, query].find(q => q.isError)?.error).message : null} />
    {ability.canAnywhere('purchasing.create') && <Card><CardBody><form className="space-y-3" onSubmit={e => { e.preventDefault(); void act(async () => {
      unwrap(await supabase.rpc('record_supplier_quotation', { p_supplier: supplier, p_warehouse: warehouse, p_reference: reference, p_valid_until: validUntil, p_notes: notes, p_lines: lines.map(({ product_id, quantity: qty, unit_cost }) => ({ product_id, quantity: qty, unit_cost })) }), 'supplierQuotations.create')
      setLines([]); setReference(''); setNotes(''); setPage(0)
    }) }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Supplier"><Select required value={supplier} onChange={e => setSupplier(e.target.value)}><option value="">Choose supplier</option>{suppliers.data?.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{s.code} / {s.name}</option>)}</Select></Field>
        <Field label="Delivery warehouse"><Select required value={warehouse} onChange={e => setWarehouse(e.target.value)}><option value="">Choose warehouse</option>{warehouses.data?.filter(w => ability.can('purchasing.create', w.branch_id)).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
        <Field label="Supplier reference"><Input required maxLength={100} value={reference} onChange={e => setReference(e.target.value)} /></Field>
        <Field label="Valid until"><Input required type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)} /></Field>
      </div>
      <Field label="Find product"><Input value={search} onChange={e => { setSearch(e.target.value); setProduct('') }} /></Field>
      <Field label="Product"><Select value={product} onChange={e => setProduct(e.target.value)}><option value="">Choose product</option>{products.data?.filter(p => !lines.some(l => l.product_id === p.id)).map(p => <option key={p.id} value={p.id}>{p.sku} / {p.brand_name}</option>)}</Select></Field>
      <div className="grid gap-3 sm:grid-cols-2"><Field label="Base-unit quantity"><Input type="number" min="0.001" step="0.001" value={quantity} onChange={e => setQuantity(e.target.value)} /></Field><Field label="Cost per base unit (supplier currency)"><Input type="number" min="0" step="0.0001" value={cost} onChange={e => setCost(e.target.value)} /></Field></div>
      <Button type="button" disabled={busy || !product || !cost || Number(cost) < 0 || Number(quantity) <= 0 || lines.length >= 100} onClick={() => { const p = products.data?.find(p => p.id === product); if (p) setLines([...lines, { product_id: p.id, quantity: Number(quantity), unit_cost: Number(cost), label: `${p.sku} / ${p.brand_name}` }]); setProduct('') }}>Add line</Button>
      <ul>{lines.map(l => <li key={l.product_id} className="flex flex-wrap justify-between gap-2">{l.label}: {l.quantity} × {l.unit_cost}<Button type="button" variant="ghost" onClick={() => setLines(lines.filter(x => x.product_id !== l.product_id))}>Remove {l.label}</Button></li>)}</ul>
      <Field label="Notes"><Textarea maxLength={1000} value={notes} onChange={e => setNotes(e.target.value)} /></Field>
      <Button type="submit" disabled={busy || !lines.length}>Save quotation</Button>
    </form></CardBody></Card>}
    {query.isError && <Button onClick={() => void query.refetch()}>Retry</Button>}
    {query.isPending ? <p>Loading quotations...</p> : !query.data?.length ? <p>No quotations on this page.</p> : query.data.map(q => <Card key={q.id}><CardBody className="space-y-2">
      <h2 className="font-semibold">{q.supplier_reference} / {suppliers.data?.find(s => s.id === q.supplier_id)?.name ?? q.supplier_id}</h2><p>{q.status} / Valid until {q.valid_until}</p><p className="break-words">{q.notes}</p>
      <details><summary>Quoted lines</summary>{Array.isArray(q.lines) && q.lines.map((l, i) => <p key={i}>{l && typeof l === 'object' && !Array.isArray(l) ? `${l.label ?? 'Product unavailable'}: ${l.quantity} × ${l.unit_cost}` : 'Invalid line'}</p>)}</details>
      {q.purchase_order_id && <Link className="underline" to={`/purchasing/orders/${q.purchase_order_id}`}>Open purchase order</Link>}
      {q.status === 'OPEN' && ability.can('purchasing.create', q.branch_id) && <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void act(async () => { const id = unwrap(await supabase.rpc('convert_supplier_quotation', { p_id: q.id }), 'supplierQuotations.convert'); navigate(`/purchasing/orders/${id}`) })}>Create draft purchase order</Button><Button disabled={busy} variant="secondary" onClick={() => void act(async () => { unwrap(await supabase.rpc('cancel_supplier_quotation', { p_id: q.id }), 'supplierQuotations.cancel') })}>Cancel quotation</Button></div>}
    </CardBody></Card>)}
    <div className="flex gap-3"><Button disabled={!page || query.isFetching} onClick={() => setPage(page - 1)}>Previous</Button><span>Page {page + 1}</span><Button disabled={query.isFetching || query.data?.length !== 25} onClick={() => setPage(page + 1)}>Next</Button></div>
  </div>
}
