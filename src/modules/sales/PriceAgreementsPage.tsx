import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, CardBody, Field, Input, Select, PageHeader, InlineError } from '@/components/ui'
import { useSession } from '@/modules/session/SessionProvider'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/services/common'
import { toAppError } from '@/lib/errors'
import { listCustomerOptions } from '@/services/customers'
import { listProductUnits, type ProductRow } from '@/services/catalog'
import { ProductPicker } from '@/modules/catalog/ProductPicker'

export function PriceAgreementsPage() {
  const { ability } = useSession(); const qc = useQueryClient()
  const [customer, setCustomer] = useState(''); const [product, setProduct] = useState<ProductRow | null>(null); const [unit, setUnit] = useState('')
  const [price, setPrice] = useState(''); const [from, setFrom] = useState(''); const [until, setUntil] = useState(''); const [reason, setReason] = useState('')
  const [page, setPage] = useState(0); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null)
  const [cancelReasons, setCancelReasons] = useState<Record<string, string>>({})
  const customers = useQuery({ queryKey: ['customer-options'], queryFn: listCustomerOptions })
  const units = useQuery({ queryKey: ['product-units', product?.id], enabled: !!product, queryFn: () => listProductUnits(product!.id) })
  const agreements = useQuery({ queryKey: ['price-agreements', customer, page], queryFn: async () => { let q = supabase.from('price_agreements').select('*').order('created_at', { ascending: false }).order('id').range(page * 25, page * 25 + 24); if (customer) q = q.eq('customer_id', customer); return unwrap(await q, 'agreements.list') } })
  async function act(fn: () => Promise<void>) { if (busy) return; setBusy(true); setError(null); try { await fn(); await qc.invalidateQueries({ queryKey: ['price-agreements'] }); await qc.invalidateQueries({ queryKey: ['resolved-price'] }) } catch (e) { setError(toAppError(e).message) } finally { setBusy(false) } }
  return <div className="space-y-4">
    <PageHeader title="Price agreements" description="Customer-specific pack prices override price lists during their validity period. Existing documents retain their stored prices." />
    <InlineError message={error ?? (agreements.isError ? toAppError(agreements.error).message : customers.isError ? toAppError(customers.error).message : units.isError ? toAppError(units.error).message : null)} />
    <Field label="Customer"><Select value={customer} onChange={e => { setCustomer(e.target.value); setPage(0) }}><option value="">All customers / choose to create</option>{customers.data?.map(c => <option key={c.id} value={c.id}>{c.code} / {c.name}</option>)}</Select></Field>
    {ability.can('pricing.manage') && <Card><CardBody><form className="space-y-3" onSubmit={e => { e.preventDefault(); void act(async () => { unwrap(await supabase.rpc('create_price_agreement', { p_customer: customer, p_unit: unit, p_price: Number(price), p_from: from, p_until: until, p_reason: reason }), 'agreements.create'); setReason(''); setPrice('') }) }}>
      <ProductPicker value={product} onChange={p => { setProduct(p); setUnit('') }} />
      <Field label="Pack unit"><Select required value={unit} onChange={e => setUnit(e.target.value)}><option value="">Choose pack</option>{units.data?.filter(u => u.is_active && u.is_sellable).map(u => <option key={u.id} value={u.id}>{u.unit?.name} / {u.factor_to_base} base units</option>)}</Select></Field>
      <div className="grid gap-3 sm:grid-cols-3"><Field label="Agreed unit price"><Input required type="number" min="0" step="0.0001" value={price} onChange={e => setPrice(e.target.value)} /></Field><Field label="Valid from"><Input required type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field><Field label="Valid until"><Input required type="date" min={from} value={until} onChange={e => setUntil(e.target.value)} /></Field></div>
      <Field label="Agreement reason"><Input required minLength={3} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></Field><Button type="submit" disabled={busy || !customer || !unit}>Save agreement</Button>
    </form></CardBody></Card>}
    {agreements.isError && <Button onClick={() => void agreements.refetch()}>Retry</Button>}
    {agreements.isPending ? <p>Loading...</p> : !agreements.data?.length ? <p>No agreements on this page.</p> : agreements.data.map(a => <Card key={a.id}><CardBody className="space-y-2"><h2>{customers.data?.find(c => c.id === a.customer_id)?.name ?? a.customer_id}</h2><p className="break-words">Pack {units.data?.find(u => u.id === a.product_unit_id)?.unit?.name ?? a.product_unit_id} / Price {a.unit_price}</p><p>{a.valid_from} to {a.valid_until} / {a.is_active ? 'Active' : 'Cancelled'}</p><p>{a.reason}</p>{a.is_active && ability.can('pricing.manage') && <><Field label={`Cancellation reason ${a.id}`}><Input maxLength={500} value={cancelReasons[a.id] ?? ''} onChange={e => setCancelReasons({ ...cancelReasons, [a.id]: e.target.value })} /></Field><Button disabled={busy || (cancelReasons[a.id] ?? '').trim().length < 3} onClick={() => void act(async () => { unwrap(await supabase.rpc('cancel_price_agreement', { p_id: a.id, p_reason: cancelReasons[a.id]! }), 'agreements.cancel') })}>Cancel agreement</Button></>}</CardBody></Card>)}
    <div className="flex gap-3"><Button disabled={!page || agreements.isFetching} onClick={() => setPage(page - 1)}>Previous</Button><span>Page {page + 1}</span><Button disabled={agreements.isFetching || agreements.data?.length !== 25} onClick={() => setPage(page + 1)}>Next</Button></div>
  </div>
}
