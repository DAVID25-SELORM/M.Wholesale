import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, CardBody, Field, Input, Select, Textarea, PageHeader, InlineError } from '@/components/ui'
import { useSession } from '@/modules/session/SessionProvider'
import { toAppError } from '@/lib/errors'
import { RequestOrderForm } from './RequestOrderForm'
import { cancelPurchaseRequest, createPurchaseRequest, decidePurchaseRequest, listPurchaseRequests, requestProducts, submitPurchaseRequest } from '@/services/purchaseRequests'

export function PurchaseRequestsPage() {
  const { selectedBranch } = useSession()
  return <Requests key={selectedBranch} />
}
function Requests() {
  const { selectedBranch, branches, ability, context } = useSession()
  const qc = useQueryClient()
  const [page, setPage] = useState(0)
  const [branch, setBranch] = useState(selectedBranch === 'ALL' ? '' : selectedBranch)
  const [date, setDate] = useState('')
  const [notes, setNotes] = useState('')
  const [search, setSearch] = useState('')
  const [product, setProduct] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [lines, setLines] = useState<{ product_id: string; quantity: number; label: string }[]>([])
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const requests = useQuery({ queryKey: ['purchase-requests', selectedBranch, page], queryFn: () => listPurchaseRequests(selectedBranch, page) })
  const products = useQuery({ queryKey: ['request-products', search], queryFn: () => requestProducts(search), enabled: ability.canAnywhere('purchasing.request') })
  async function act(action: () => Promise<unknown>) {
    if (busy) return
    setBusy(true); setError(null)
    try { await action(); await qc.invalidateQueries({ queryKey: ['purchase-requests'] }) }
    catch (e) { setError(toAppError(e).message) }
    finally { setBusy(false) }
  }
  return <div className="space-y-4 min-w-0">
    <PageHeader title="Purchase requests" description="Request products in base units, then submit for independent approval." />
    <InlineError message={error} />
    {ability.canAnywhere('purchasing.request') && <Card><CardBody><form className="space-y-3" onSubmit={e => {
      e.preventDefault()
      void act(async () => { await createPurchaseRequest(branch, date, notes, lines.map(({ product_id, quantity: qty }) => ({ product_id, quantity: qty }))); setLines([]); setNotes(''); setPage(0) })
    }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Request branch"><Select required value={branch} onChange={e => setBranch(e.target.value)}><option value="">Choose branch</option>{branches.filter(b => b.is_active && ability.can('purchasing.request', b.id)).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        <Field label="Required date"><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
      </div>
      <Field label="Find product by name"><Input value={search} onChange={e => { setSearch(e.target.value); setProduct('') }} /></Field>
      <InlineError message={products.isError ? toAppError(products.error).message : null} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Product"><Select value={product} onChange={e => setProduct(e.target.value)}><option value="">{products.isFetching ? 'Loading products…' : 'Choose product'}</option>{products.data?.filter(p => !lines.some(l => l.product_id === p.id)).map(p => <option key={p.id} value={p.id}>{p.sku} / {p.brand_name}</option>)}</Select></Field>
        <Field label="Base-unit quantity"><Input type="number" min="0.001" max="1000000000" step="0.001" value={quantity} onChange={e => setQuantity(e.target.value)} /></Field>
      </div>
      <Button type="button" variant="secondary" disabled={busy || !product || !(Number(quantity) > 0) || lines.length >= 100} onClick={() => {
        const p = products.data?.find(x => x.id === product)
        if (p) setLines([...lines, { product_id: p.id, quantity: Number(quantity), label: `${p.sku} / ${p.brand_name}` }])
        setProduct(''); setQuantity('1')
      }}>Add line</Button>
      <ul>{lines.map(l => <li key={l.product_id} className="flex flex-wrap justify-between gap-2 py-2"><span>{l.label} — {l.quantity} base units</span><Button type="button" variant="ghost" onClick={() => setLines(lines.filter(x => x.product_id !== l.product_id))}>Remove {l.label}</Button></li>)}</ul>
      <Field label="Request notes"><Textarea maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)} /></Field>
      <Button type="submit" disabled={busy || !lines.length || !ability.can('purchasing.request', branch)}>Save draft</Button>
    </form></CardBody></Card>}
    <InlineError message={requests.isError ? toAppError(requests.error).message : null} />
    {requests.isError && <Button onClick={() => void requests.refetch()}>Retry</Button>}
    {requests.isPending ? <p>Loading purchase requests…</p> : !requests.isError && !requests.data?.length ? <p>No purchase requests on this page.</p> : requests.data?.map(r => {
      const own = r.requested_by === context.user_id
      const reason = reasons[r.id] ?? ''
      return <Card key={r.id}><CardBody className="space-y-3">
        <h2 className="font-semibold">{r.request_number} — {r.status}</h2>
        <p>{branches.find(b => b.id === r.branch_id)?.name} · Required: {r.needed_by ?? 'Not specified'}</p>
        <p className="whitespace-pre-wrap break-words">{r.notes}</p>
        <details><summary>Requested lines</summary><ul>{Array.isArray(r.lines) && r.lines.map((line, i) => <li key={i} className="break-words">{line && typeof line === 'object' && !Array.isArray(line) ? `${line.label ?? line.product_id} — ${line.quantity} base units` : 'Invalid legacy line'}</li>)}</ul></details>
        {r.decision_note && <p className="break-words">Decision: {r.decision_note}</p>}
        {r.status === 'APPROVED' && ability.can('purchasing.create', r.branch_id) && ability.can('purchasing.request', r.branch_id) && <RequestOrderForm request={r} refresh={() => qc.invalidateQueries({ queryKey: ['purchase-requests'] })} />}
        {['DRAFT', 'SUBMITTED'].includes(r.status) && <>
          <Field label={`Decision or cancellation reason for ${r.request_number}`}><Input maxLength={1000} value={reason} onChange={e => setReasons({ ...reasons, [r.id]: e.target.value })} /></Field>
          <div className="flex flex-wrap gap-2">
            {own && ability.can('purchasing.request', r.branch_id) && <>
              {r.status === 'DRAFT' && <Button disabled={busy} onClick={() => void act(() => submitPurchaseRequest(r.id))}>Submit request</Button>}
              <Button variant="secondary" disabled={busy || reason.trim().length < 3} onClick={() => void act(() => cancelPurchaseRequest(r.id, reason))}>Cancel request</Button>
            </>}
            {!own && r.status === 'SUBMITTED' && ability.can('purchasing.request_approve', r.branch_id) && <>
              <Button disabled={busy || reason.trim().length < 3} onClick={() => void act(() => decidePurchaseRequest(r.id, true, reason))}>Approve</Button>
              <Button variant="secondary" disabled={busy || reason.trim().length < 3} onClick={() => void act(() => decidePurchaseRequest(r.id, false, reason))}>Reject</Button>
            </>}
          </div>
        </>}
      </CardBody></Card>
    })}
    <div className="flex flex-wrap gap-3"><Button variant="secondary" disabled={page === 0 || requests.isFetching} onClick={() => setPage(page - 1)}>Previous</Button><span>Page {page + 1}</span><Button variant="secondary" disabled={requests.isFetching || requests.data?.length !== 25} onClick={() => setPage(page + 1)}>Next</Button></div>
  </div>
}
