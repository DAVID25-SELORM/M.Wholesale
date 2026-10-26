import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Badge, Button, Card, CardBody, DataTable, EmptyState, ErrorState, Field, InlineError, Input, LoadingState, Modal, PageHeader, Select, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import { ReasonDialog } from '@/modules/purchasing/shared'
import { addStop, cancelRun, createRun, dispatchRun, listRuns, loadStop, recordOutcome, removeStop, reorderStops, returnStop, runOptions, runStops, startLoading, type DeliveryRun, type RunStop } from '@/services/runs'

export function DeliveryRunsPage() {
  const { ability, selectedBranch } = useSession()
  const [creating, setCreating] = useState(false)
  const query = useQuery({ queryKey: ['delivery-runs'], queryFn: listRuns, refetchInterval: 20_000 })
  const columns: Column<DeliveryRun>[] = [
    { key: 'number', header: 'Run', render: r => <Link className="font-semibold text-brand-700 hover:underline" to={`/delivery/runs/${r.id}`}>{r.run_number}</Link> },
    { key: 'date', header: 'Date', render: r => r.run_date },
    { key: 'driver', header: 'Driver', render: r => r.driver_name },
    { key: 'vehicle', header: 'Vehicle', render: r => r.vehicle_number },
    { key: 'stops', header: 'Stops', render: r => r.stop_count },
    { key: 'status', header: 'Status', render: r => <Badge>{r.status.replaceAll('_', ' ')}</Badge> },
  ]
  return <><PageHeader title="Delivery runs" description="Plan, load and track deliveries. Drivers see only their own assigned runs." actions={ability.can('runs.manage') && <Button onClick={() => setCreating(true)}>New run</Button>} />
    <Card><DataTable caption="Delivery runs" columns={columns} rows={(query.data ?? []).filter(r => selectedBranch === 'ALL' || r.branch_id === selectedBranch)} rowKey={r => r.id} loading={query.isFetching} error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()} emptyTitle="No delivery runs" emptyDescription="Dispatchers plan runs using ready delivery notes, a driver and a vehicle." /></Card>
    {creating && <NewRun onClose={() => setCreating(false)} />}</>
}
function NewRun({ onClose }: { onClose: () => void }) {
  const { branches, ability, selectedBranch } = useSession()
  const choices = branches.filter(b => b.is_active && ability.can('runs.manage', b.id))
  const [branch, setBranch] = useState(choices.find(b => b.id === selectedBranch)?.id ?? choices[0]?.id ?? '')
  const [driver, setDriver] = useState(''); const [vehicle, setVehicle] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [error, setError] = useState<string | null>(null)
  const options = useQuery({ queryKey: ['run-options', branch], queryFn: () => runOptions(branch), enabled: !!branch })
  const navigate = useNavigate(); const qc = useQueryClient()
  const create = useMutation({ mutationFn: () => createRun(branch, driver, vehicle, date), onSuccess: async id => { await qc.invalidateQueries({ queryKey: ['delivery-runs'] }); onClose(); navigate(`/delivery/runs/${id}`) }, onError: e => setError(toAppError(e).message) })
  return <Modal open title="Plan delivery run" onClose={onClose} footer={<Button disabled={!driver || !vehicle || !date} loading={create.isPending} onClick={() => create.mutate()}>Create run</Button>}>
    <div className="space-y-3"><InlineError message={error ?? (options.isError ? toAppError(options.error).message : null)} />
      <Field label="Branch"><Select value={branch} onChange={e => { setBranch(e.target.value); setDriver(''); setVehicle('') }}>{choices.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
      <Field label="Run date"><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
      <Field label="Driver"><Select value={driver} onChange={e => setDriver(e.target.value)}><option value="">Choose driver</option>{options.data?.drivers.map(d => <option key={d.id} value={d.id}>{d.name} · licence expires {d.licence_expiry ?? 'not entered'}</option>)}</Select></Field>
      <Field label="Vehicle"><Select value={vehicle} onChange={e => setVehicle(e.target.value)}><option value="">Choose vehicle</option>{options.data?.vehicles.map(v => <option key={v.id} value={v.id}>{v.name} · {v.capacity_packages ?? '?'} packages / {v.capacity_kg ?? '?'} kg {v.refrigerated ? '· refrigerated' : ''}</option>)}</Select></Field>
      <p className="text-sm text-slate-600">Driver and vehicle must be available, have valid documents for the run date, and belong to this branch. Set both vehicle capacities before planning.</p>
    </div></Modal>
}
export function DeliveryRunPage() {
  const { id = '' } = useParams()
  const query = useQuery({ queryKey: ['delivery-runs'], queryFn: listRuns, refetchInterval: 20_000 })
  if (query.isPending) return <LoadingState />
  if (query.isError) return <ErrorState message={toAppError(query.error).message} onRetry={() => void query.refetch()} />
  const run = query.data.find(r => r.id === id)
  if (!run) return <EmptyState title="Run not found" />
  return <RunTask key={id} run={run} />
}
function RunTask({ run }: { run: DeliveryRun }) {
  const { ability } = useSession(); const qc = useQueryClient()
  const manage = ability.can('runs.manage', run.branch_id)
  const outcome = manage || ability.can('runs.drive', run.branch_id)
  const [note, setNote] = useState(''); const [weight, setWeight] = useState(''); const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState<{ kind: 'cancel' | 'remove'; id: string } | null>(null)
  const [delivering, setDelivering] = useState<RunStop | null>(null)
  const [receiver, setReceiver] = useState(''); const [outcomeReason, setOutcomeReason] = useState(''); const [delivered, setDelivered] = useState(true)
  const [loadingStop, setLoadingStop] = useState<RunStop | null>(null); const [loadCount, setLoadCount] = useState('')
  const stops = useQuery({ queryKey: ['run-stops', run.id], queryFn: () => runStops(run.id), refetchInterval: 20_000 })
  const options = useQuery({ queryKey: ['run-options', run.branch_id], queryFn: () => runOptions(run.branch_id), enabled: manage && run.status === 'PLANNED' })
  const action = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSuccess: async () => {
    setError(null); setReason(null); setDelivering(null); setLoadingStop(null); setNote(''); setWeight('')
    await Promise.all(['delivery-runs', 'run-stops', 'run-options', 'delivery-notes', 'fulfilment-queue'].map(k => qc.invalidateQueries({ queryKey: [k] })))
  }, onError: e => setError(toAppError(e).message) })
  const active = (stops.data ?? []).filter(s => s.status !== 'REMOVED')
  function move(id: string, offset: number) {
    const ids = active.map(s => s.id); const index = ids.indexOf(id); const other = index + offset
    if (other < 0 || other >= ids.length) return
    ;[ids[index], ids[other]] = [ids[other]!, ids[index]!]
    action.mutate(() => reorderStops(run.id, ids))
  }
  if (stops.isPending) return <LoadingState />
  if (stops.isError) return <ErrorState message={toAppError(stops.error).message} onRetry={() => void stops.refetch()} />
  return <><Link to="/delivery/runs" className="text-brand-700 print:hidden">← Delivery runs</Link>
    <PageHeader title={run.run_number} description={`${run.run_date} · ${run.driver_name} · ${run.vehicle_number}`} actions={<Badge>{run.status.replaceAll('_', ' ')}</Badge>} />
    <InlineError message={error} />
    <p className="mb-4">Load: {active.reduce((n, s) => n + s.package_count, 0)} / {run.capacity_packages} packages · {active.reduce((n, s) => n + Number(s.weight_kg), 0).toFixed(2)} / {run.capacity_kg} kg {run.refrigerated && '· Refrigerated vehicle'}</p>
    <div className="mb-4 flex flex-wrap gap-3 print:hidden">
      <Button variant="secondary" onClick={() => window.print()}>Print run sheet / Save PDF</Button>
      {manage && run.status === 'PLANNED' && <Button disabled={!active.length} loading={action.isPending} onClick={() => action.mutate(() => startLoading(run.id))}>Start loading</Button>}
      {manage && run.status === 'LOADING' && <Button disabled={active.some(s => !s.loaded_at)} loading={action.isPending} onClick={() => action.mutate(() => dispatchRun(run.id))}>Dispatch run</Button>}
      {manage && ['PLANNED', 'LOADING'].includes(run.status) && <Button variant="ghost" disabled={action.isPending} onClick={() => setReason({ kind: 'cancel', id: run.id })}>Cancel run</Button>}
    </div>
    {manage && run.status === 'PLANNED' && <Card className="mb-4 print:hidden"><CardBody><h2 className="mb-3 font-semibold">Add prepared delivery</h2>
      <InlineError message={options.isError ? toAppError(options.error).message : null} />
      <Field label="Delivery note"><Select value={note} onChange={e => setNote(e.target.value)}><option value="">Choose packed delivery</option>{options.data?.notes.map(n => <option key={n.id} value={n.id}>{n.name} · {n.packages} packages</option>)}</Select></Field>
      <Field label="Measured load weight (kg)"><Input type="number" min="0.01" step="0.01" value={weight} onChange={e => setWeight(e.target.value)} /></Field>
      <Button disabled={!note || !Number.isFinite(Number(weight)) || Number(weight) <= 0} loading={action.isPending} onClick={() => action.mutate(() => addStop(run.id, note, Number(weight)))}>Add stop</Button>
    </CardBody></Card>}
    <div className="space-y-4">{active.map((s, index) => <Card key={s.id}><CardBody>
      <div className="flex flex-wrap justify-between gap-2"><h2 className="font-semibold">{index + 1}. {s.customer_name}</h2><Badge>{s.status}</Badge></div>
      <p>{s.note_number} · Invoice {s.invoice_number}</p><p>{s.delivery_address ?? 'No address recorded'}</p><p>{s.contact_name} {s.contact_phone}</p>
      <p>{s.package_count} packages · {s.weight_kg} kg {s.cold_chain && '· COLD CHAIN'} · {s.loaded_at ? 'Load confirmed' : 'Not loaded'}</p>
      <p>Amount due: {s.currency_code} {Number(s.balance_due).toFixed(2)}</p>{s.notes && <p>Instructions: {s.notes}</p>}
      {s.outcome_at && <p>{s.receiver_name ? `Received by ${s.receiver_name}` : s.reason} · {new Date(s.outcome_at).toLocaleString()}</p>}
      {s.status === 'FAILED' && <p>{s.returned_at ? 'Returned to warehouse' : 'Awaiting return to warehouse'}</p>}
      <div className="mt-3 flex flex-wrap gap-2 print:hidden">
        {manage && run.status === 'PLANNED' && <><Button variant="secondary" disabled={action.isPending || index === 0} onClick={() => move(s.id, -1)}>Move up</Button><Button variant="secondary" disabled={action.isPending || index === active.length - 1} onClick={() => move(s.id, 1)}>Move down</Button><Button variant="ghost" disabled={action.isPending} onClick={() => setReason({ kind: 'remove', id: s.id })}>Remove stop</Button></>}
        {manage && run.status === 'LOADING' && !s.loaded_at && <Button disabled={action.isPending} onClick={() => { setLoadingStop(s); setLoadCount(''); setError(null) }}>Confirm loaded packages</Button>}
        {outcome && run.status === 'ON_ROAD' && s.status === 'PENDING' && <Button disabled={action.isPending} onClick={() => { setDelivering(s); setReceiver(''); setOutcomeReason(''); setDelivered(true); setError(null) }}>Record delivery outcome</Button>}
        {manage && s.status === 'FAILED' && !s.returned_at && <Button disabled={action.isPending} onClick={() => action.mutate(() => returnStop(s.id))}>Confirm goods returned</Button>}
      </div>
    </CardBody></Card>)}</div>
    {(stops.data ?? []).filter(s => s.status === 'REMOVED').map(s => <p className="mt-3 text-sm text-slate-500" key={s.id}>Removed: {s.note_number} — {s.reason}</p>)}
    {reason && <ReasonDialog open title={reason.kind === 'cancel' ? 'Cancel run' : 'Remove stop'} description="The reason is retained in the audit record. Unload any goods already on the vehicle before cancelling." confirmLabel="Confirm" busy={action.isPending} error={error} onClose={() => setReason(null)} onConfirm={text => action.mutate(() => reason.kind === 'cancel' ? cancelRun(reason.id, text) : removeStop(reason.id, text))} />}
    {loadingStop && <Modal open title="Confirm loading" onClose={() => setLoadingStop(null)} footer={<Button loading={action.isPending} disabled={Number(loadCount) !== loadingStop.package_count} onClick={() => action.mutate(() => loadStop(loadingStop.id, Number(loadCount)))}>Confirm load</Button>}><InlineError message={error} /><p>Check all {loadingStop.package_count} packages for {loadingStop.customer_name} onto the vehicle.</p><Field label="Packages counted"><Input type="number" min="1" step="1" value={loadCount} onChange={e => setLoadCount(e.target.value)} /></Field></Modal>}
    {delivering && <Modal open title={`Delivery: ${delivering.customer_name}`} onClose={() => setDelivering(null)} footer={<Button loading={action.isPending} disabled={delivered ? !receiver.trim() : outcomeReason.trim().length < 3} onClick={() => action.mutate(() => recordOutcome(delivering.id, delivered, receiver, outcomeReason))}>Save outcome</Button>}><div className="space-y-3"><InlineError message={error} /><Field label="Outcome"><Select value={delivered ? 'DELIVERED' : 'FAILED'} onChange={e => setDelivered(e.target.value === 'DELIVERED')}><option value="DELIVERED">Delivered</option><option value="FAILED">Failed delivery</option></Select></Field>{delivered && <Field label="Received by" required><Input maxLength={120} value={receiver} onChange={e => setReceiver(e.target.value)} /></Field>}<Field label={delivered ? 'Notes' : 'Failure reason'} required={!delivered}><Input maxLength={500} value={outcomeReason} onChange={e => setOutcomeReason(e.target.value)} /></Field></div></Modal>}
  </>
}
