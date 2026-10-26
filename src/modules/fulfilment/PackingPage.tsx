import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button, Card, CardBody, Checkbox, DataTable, EmptyState, ErrorState, Field, InlineError, Input, LoadingState, PageHeader, Select, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import { ReasonDialog } from '@/modules/purchasing/shared'
import { getInvoiceDelivery } from '@/services/deliveries'
import { getFulfilmentOrder, getPickLines, getQueue, type QueueRow } from '@/services/fulfilment'
import { createPackage, finishPacking, getDispatchQueue, getPackingDetail, packLine, preparePackedDelivery, startPacking, verifyPackedLine, voidPackage } from '@/services/packing'
import { FulfilmentStatusBadge } from './PickingQueuePage'

export function PackingQueuePage({ dispatch = false }: { dispatch?: boolean }) {
  const { selectedBranch } = useSession()
  const query = useQuery({ queryKey: ['fulfilment-queue', dispatch ? 'dispatch' : null, false], queryFn: () => dispatch ? getDispatchQueue() : getQueue(null, false), refetchInterval: 30_000 })
  const rows = (query.data ?? []).filter(r => (dispatch ? ['PACKED', 'READY'] : ['PICKED', 'PACKING', 'PACKED']).includes(r.status) && (selectedBranch === 'ALL' || r.branch_id === selectedBranch))
  const columns: Column<QueueRow>[] = [
    { key: 'order', header: 'Order', render: r => <Link className="font-semibold text-brand-700 hover:underline" to={`/warehouse/packing/${r.id}`}>{r.order_number}</Link> },
    { key: 'customer', header: 'Customer', render: r => r.customer_name },
    { key: 'warehouse', header: 'Warehouse', render: r => r.warehouse_name },
    { key: 'status', header: 'Status', render: r => <FulfilmentStatusBadge status={r.status} /> },
    { key: 'due', header: 'Needed by', render: r => r.required_by ?? '—' },
  ]
  return <><PageHeader title={dispatch ? 'Dispatch' : 'Packing'} description={dispatch ? 'Sealed orders: open an order to prepare its delivery note, then assign a driver and dispatch. Delivery notes track on-road, delivered and failed outcomes.' : 'Pack each picked quantity into labelled packages, verify controlled medicines, then seal the order.'} />
    {dispatch && <Link className="mb-4 inline-block text-brand-700 hover:underline" to="/sales/deliveries">Open delivery notes and track delivery outcomes →</Link>}
    <Card><DataTable caption={dispatch ? 'Packed orders' : 'Packing orders'} columns={columns} rows={rows} rowKey={r => r.id} loading={query.isFetching} error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()} emptyTitle="No orders waiting" emptyDescription="Orders appear after picking is complete." /></Card></>
}

export function PackingPage() {
  const { id = '' } = useParams()
  const order = useQuery({ queryKey: ['fulfilment-order', id], queryFn: () => getFulfilmentOrder(id), refetchInterval: 20_000 })
  if (order.isPending) return <LoadingState />
  if (order.isError) return <ErrorState message={toAppError(order.error).message} onRetry={() => void order.refetch()} />
  if (!order.data) return <EmptyState title="Order not found" />
  return <PackingTask key={id} order={order.data} />
}

function PackingTask({ order }: { order: QueueRow }) {
  const { ability } = useSession()
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState('CARTON')
  const [cold, setCold] = useState(false)
  const [fragile, setFragile] = useState(false)
  const [packageId, setPackageId] = useState('')
  const [lineId, setLineId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [voidId, setVoidId] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [contact, setContact] = useState('')
  const [phone, setPhone] = useState('')
  const [notes, setNotes] = useState('')
  const detail = useQuery({ queryKey: ['packing-detail', order.id], queryFn: () => getPackingDetail(order.id), refetchInterval: 20_000 })
  const lines = useQuery({ queryKey: ['fulfilment-lines', order.id], queryFn: () => getPickLines(order.id), refetchInterval: 20_000 })
  const canDeliver = ability.can('deliveries.view', order.branch_id)
  const delivery = useQuery({ queryKey: ['invoice-delivery', order.invoice_id], queryFn: () => getInvoiceDelivery(order.invoice_id), enabled: canDeliver })
  const canPack = ability.can('packing.work', order.branch_id)
  const packing = order.status === 'PACKING'
  const packages = detail.data?.packages ?? []
  const active = packages.filter(p => !p.voided_at)
  const contents = detail.data?.contents ?? []
  const components = detail.data?.components ?? []
  const selectedComponent = components.find(c => `${c.pick_line_id}:${c.batch_id ?? ''}` === lineId)
  const batchTotal = (id: string, batch: string | null) => contents.filter(c => c.pick_line_id === id && c.batch_id === batch && active.some(p => p.id === c.package_id)).reduce((sum, c) => sum + Number(c.quantity), 0)
  const totals = (id: string) => contents.filter(c => c.pick_line_id === id && active.some(p => p.id === c.package_id)).reduce((sum, c) => sum + Number(c.quantity), 0)
  const run = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => action(),
    onSuccess: async () => {
      setError(null); setVoidId(null); setQuantity('')
      await Promise.all(['packing-detail', 'fulfilment-order', 'fulfilment-queue', 'invoice-delivery', 'delivery-notes'].map(k => qc.invalidateQueries({ queryKey: [k] })))
    },
    onError: e => setError(toAppError(e).message),
  })
  if (detail.isPending || lines.isPending) return <LoadingState />
  if (detail.isError || lines.isError) return <ErrorState message={toAppError(detail.error ?? lines.error).message} onRetry={() => { void detail.refetch(); void lines.refetch() }} />
  return <>
    <Link to="/warehouse/packing" className="text-brand-700 hover:underline">← Packing queue</Link>
    <PageHeader title={order.order_number} description={`${order.customer_name} · ${order.warehouse_name} · ${order.invoice_number ?? ''}`} actions={<FulfilmentStatusBadge status={order.status} />} />
    <InlineError message={error} />
    <div className="mb-4 flex gap-3 print:hidden">
      {canPack && order.status === 'PICKED' && <Button loading={run.isPending} onClick={() => run.mutate(() => startPacking(order.id))}>Start packing</Button>}
      {canPack && packing && <Button loading={run.isPending} onClick={() => run.mutate(() => finishPacking(order.id))}>Seal packing</Button>}
      <Button variant="secondary" onClick={() => window.print()}>Print packing list and labels</Button>
      <Link to={`/warehouse/picking/${order.id}`} className="self-center text-brand-700 hover:underline">View pick record</Link>
    </div>
    <Card><CardBody><h2 className="mb-3 font-semibold">Quantity reconciliation</h2>
      {(lines.data ?? []).map(l => {
        const info = detail.data?.lines.find(x => x.id === l.line_id)
        return <div key={l.line_id} className="flex flex-wrap items-center justify-between gap-3 border-b py-3">
          <div><strong>{l.product_name}</strong><p className="text-sm text-slate-600">Batch {l.batch_number ?? '—'} · Picked {l.picked_quantity ?? 0} {l.base_unit} · Packed {totals(l.line_id)}</p>
            {info?.controlled && <p className="text-sm font-semibold text-amber-700">Controlled medicine · {info.verified ? 'Independently verified' : 'Independent verification required'}</p>}</div>
          {packing && info?.controlled && !info.verified && ability.can('packing.verify', order.branch_id) && <Button variant="secondary" disabled={run.isPending} onClick={() => run.mutate(() => verifyPackedLine(l.line_id))}>Verify contents</Button>}
        </div>
      })}
    </CardBody></Card>
    {packing && canPack && <div className="my-4 grid gap-4 md:grid-cols-2 print:hidden">
      <Card><CardBody><h2 className="mb-3 font-semibold">New package</h2>
        <Field label="Package type"><Select value={kind} onChange={e => setKind(e.target.value)}><option value="CARTON">Carton</option><option value="BAG">Bag</option><option value="COOL_BOX">Cool box</option></Select></Field>
        <Checkbox label="Cold chain" checked={cold} onChange={e => setCold(e.target.checked)} /><Checkbox label="Fragile" checked={fragile} onChange={e => setFragile(e.target.checked)} />
        <Button disabled={run.isPending} onClick={() => run.mutate(async () => { const id = await createPackage(order.id, kind, cold, fragile); setPackageId(id) })}>Add package</Button>
      </CardBody></Card>
      <Card><CardBody><h2 className="mb-3 font-semibold">Pack goods</h2>
        <Field label="Package"><Select value={packageId} onChange={e => setPackageId(e.target.value)}><option value="">Choose a package</option>{active.map(p => <option key={p.id} value={p.id}>{p.package_number}</option>)}</Select></Field>
        <Field label="Picked line"><Select value={lineId} onChange={e => setLineId(e.target.value)}><option value="">Choose product and batch</option>{components.map(c => { const l = lines.data?.find(x => x.line_id === c.pick_line_id); const key = `${c.pick_line_id}:${c.batch_id ?? ''}`; return <option key={key} value={key}>{l?.product_name} / {c.batch_number ?? 'No batch'} / {Number((Number(c.quantity) - batchTotal(c.pick_line_id, c.batch_id)).toFixed(3))} remaining</option> })}</Select></Field>
        <Field label="Quantity (base units)"><Input type="number" min="0.001" step="0.001" value={quantity} onChange={e => setQuantity(e.target.value)} /></Field>
        <Button disabled={run.isPending || !packageId || !selectedComponent || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0} onClick={() => run.mutate(() => packLine(packageId, selectedComponent!.pick_line_id, Number(quantity), selectedComponent!.batch_id))}>Confirm packed quantity</Button>
      </CardBody></Card>
    </div>}
    <div className="my-4 grid gap-4 md:grid-cols-2">{packages.map(p => <Card key={p.id}><CardBody>
      <h2 className="font-mono text-lg font-bold">{p.package_number}</h2><p>{order.customer_name} · {order.order_number}</p>
      <p>{p.kind} {p.cold_chain && '· COLD CHAIN'} {p.fragile && '· FRAGILE'} {p.voided_at && '· VOID'}</p>
      {p.voided_at && <p>{p.void_reason}</p>}
      <ul className="my-3 space-y-1">{contents.filter(c => c.package_id === p.id).map(c => { const l = lines.data?.find(x => x.line_id === c.pick_line_id); const component = components.find(x => x.pick_line_id === c.pick_line_id && x.batch_id === c.batch_id); return <li key={c.id}>{l?.product_name} · Batch {component?.batch_number ?? '—'} · {c.quantity} {l?.base_unit} · Expiry {component?.expiry_date ?? '—'}</li> })}</ul>
      {packing && canPack && !p.voided_at && <Button className="print:hidden" variant="ghost" disabled={run.isPending} onClick={() => setVoidId(p.id)}>Void package and repack</Button>}
    </CardBody></Card>)}</div>
    {['PACKED', 'READY'].includes(order.status) && canDeliver && <Card><CardBody>
      <h2 className="mb-3 font-semibold">Dispatch handoff</h2>
      {delivery.isPending ? <LoadingState /> : delivery.isError ? <ErrorState message={toAppError(delivery.error).message} onRetry={() => void delivery.refetch()} /> : delivery.data ? <><p>{delivery.data.note_number} · {delivery.data.status}</p><Link className="text-brand-700 hover:underline" to={`/sales/deliveries/${delivery.data.id}`}>Open delivery: assign driver, dispatch, or record outcome →</Link></> : ability.can('deliveries.create', order.branch_id) ? <div className="space-y-3 print:hidden">
        <p>{active.length} sealed packages will be attached to the delivery note.</p>
        <Field label="Delivery address" required><Input maxLength={300} value={address} onChange={e => setAddress(e.target.value)} /></Field>
        <Field label="Contact name"><Input maxLength={120} value={contact} onChange={e => setContact(e.target.value)} /></Field>
        <Field label="Contact phone"><Input maxLength={40} value={phone} onChange={e => setPhone(e.target.value)} /></Field>
        <Field label="Driver instructions"><Input maxLength={500} value={notes} onChange={e => setNotes(e.target.value)} /></Field>
        <Button disabled={run.isPending || !address.trim()} onClick={() => run.mutate(() => preparePackedDelivery(order.id, address, contact, phone, notes))}>Prepare delivery</Button>
      </div> : <p>A dispatcher must prepare the delivery note.</p>}
    </CardBody></Card>}
    {voidId && <ReasonDialog open confirmLabel="Void package" title="Void package" description="The contents remain in the audit record. Repack them into a new package before sealing." onClose={() => setVoidId(null)} onConfirm={reason => run.mutate(() => voidPackage(voidId, reason))} busy={run.isPending} error={error} />}
  </>
}
