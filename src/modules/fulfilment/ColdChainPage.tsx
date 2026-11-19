import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, CardBody, DataTable, Field, InlineError, Input, PageHeader, Select, Textarea, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { useSession } from '@/modules/session/SessionProvider'
import { STAGE_LABEL, TEMPERATURE_STAGES, listColdPackages, listExcursions, listRecentReadings, recordReading, resolveExcursion, type ColdPackage, type TemperatureExcursion, type TemperatureStage } from '@/services/temperature'

export function ColdChainPage() {
  const qc = useQueryClient()
  const { ability } = useSession()
  const packages = useQuery({ queryKey: ['cold-packages'], queryFn: listColdPackages, refetchInterval: 30_000 })
  const readings = useQuery({ queryKey: ['temperature-readings'], queryFn: () => listRecentReadings(), refetchInterval: 30_000 })
  const excursions = useQuery({ queryKey: ['temperature-excursions'], queryFn: () => listExcursions(), refetchInterval: 30_000 })
  const [packageId, setPackageId] = useState('')
  const [stage, setStage] = useState<TemperatureStage>('PACKING')
  const [temperature, setTemperature] = useState('')
  const [note, setNote] = useState('')
  const [decide, setDecide] = useState<{ row: TemperatureExcursion; decision: 'ACCEPT_USE' | 'REJECT_GOODS' } | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const refresh = () => Promise.all(['cold-packages', 'temperature-readings', 'temperature-excursions'].map(k => qc.invalidateQueries({ queryKey: [k] })))
  const canRecord = ability.can('temperature.record')
  const canDecide = ability.can('temperature.decide')
  const byPackage = new Map((packages.data ?? []).map(p => [p.package_id, p]))
  const byReading = new Map((readings.data ?? []).map(r => [r.id, r]))

  async function submitReading(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const result = await recordReading(packageId, stage, Number(temperature), note)
      setNotice(result.within_range
        ? `Recorded. ${temperature} °C is within the ${result.limit_min_c} to ${result.limit_max_c} °C range for ${result.storage_condition.toLowerCase()} goods.`
        : `Recorded. ${temperature} °C is outside the ${result.limit_min_c} to ${result.limit_max_c} °C range. An excursion is open and the delivery cannot be dispatched until it is decided.`)
      setTemperature(''); setNote('')
      await refresh()
    } catch (err) { setError(toAppError(err).message) } finally { setBusy(false) }
  }
  async function submitDecision(e: FormEvent) {
    e.preventDefault()
    if (!decide || busy) return
    setBusy(true); setError(null)
    try { await resolveExcursion(decide.row.id, decide.decision, reason); setDecide(null); setReason(''); await refresh() } catch (err) { setError(toAppError(err).message) } finally { setBusy(false) }
  }

  const packageColumns: Column<ColdPackage>[] = [
    { key: 'pkg', header: 'Package', render: p => <span className="font-mono text-xs font-semibold">{p.package_number}</span> },
    { key: 'order', header: 'Order', render: p => <Link to={`/warehouse/packing/${p.fulfilment_order_id}`} className="text-brand-700 hover:underline">{p.order_number}</Link> },
    { key: 'cust', header: 'Customer', hideOnMobile: true, render: p => p.customer_name },
    { key: 'last', header: 'Latest reading', render: p => p.latest_temperature_c == null ? <span className="text-slate-500">None yet</span> : <span>{p.latest_temperature_c} °C <Badge tone={p.latest_within_range ? 'green' : 'red'}>{p.latest_within_range ? 'In range' : 'Out of range'}</Badge></span> },
    { key: 'ex', header: 'Excursions', render: p => p.open_excursions > 0 ? <Badge tone="red">{p.open_excursions} to decide</Badge> : p.rejected_excursions > 0 ? <Badge tone="amber">Rejected, repack</Badge> : '—' },
  ]
  const excursionColumns: Column<TemperatureExcursion>[] = [
    { key: 'pkg', header: 'Package', render: x => <span className="font-mono text-xs">{byPackage.get(x.package_id)?.package_number ?? x.package_id.slice(0, 8)}</span> },
    { key: 'temp', header: 'Reading', render: x => { const r = byReading.get(x.reading_id); return r ? <span>{r.temperature_c} °C <span className="text-slate-500">(limit {r.limit_min_c} to {r.limit_max_c})</span></span> : '—' } },
    { key: 'when', header: 'Recorded', hideOnMobile: true, render: x => formatDateTime(x.created_at) },
    { key: 'status', header: 'Status', render: x => x.status === 'OPEN' ? <Badge tone="red">Needs decision</Badge> : <Badge tone={x.decision === 'ACCEPT_USE' ? 'green' : 'amber'}>{x.decision === 'ACCEPT_USE' ? 'Accepted for use' : 'Goods rejected'}</Badge> },
    { key: 'why', header: 'Reason', hideOnMobile: true, render: x => x.decision_reason ?? '—' },
    { key: 'act', header: 'Decision', render: x => x.status === 'OPEN' && canDecide ? <div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => { setDecide({ row: x, decision: 'ACCEPT_USE' }); setReason(''); setError(null) }}>Accept for use</Button><Button size="sm" variant="secondary" onClick={() => { setDecide({ row: x, decision: 'REJECT_GOODS' }); setReason(''); setError(null) }}>Reject goods</Button></div> : null },
  ]

  return <>
    <PageHeader title="Cold chain" description="Record temperatures for cold-chain packages. A reading outside the allowed range opens an excursion that a different person must accept or reject before the delivery can be dispatched." />
    <InlineError message={error} />
    {notice && <p role="status" className="mb-4">{notice}</p>}
    {decide && <Card><CardBody><form className="space-y-3" onSubmit={e => void submitDecision(e)}>
      <h2 className="font-semibold">{decide.decision === 'ACCEPT_USE' ? 'Accept goods for use' : 'Reject goods'}</h2>
      <p className="text-sm">{decide.decision === 'ACCEPT_USE' ? 'Confirm the goods remain within their stability limits. Your decision and reason are kept as an audit record.' : 'Rejected goods cannot be dispatched. Void the package and repack from good stock.'}</p>
      <Field label="Reason" required><Textarea required minLength={10} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></Field>
      <div className="flex gap-2"><Button type="submit" disabled={busy || reason.trim().length < 10}>Confirm decision</Button><Button type="button" variant="secondary" onClick={() => setDecide(null)}>Cancel</Button></div>
    </form></CardBody></Card>}
    {canRecord && <Card><CardBody><form className="grid gap-3 sm:grid-cols-4" onSubmit={e => void submitReading(e)}>
      <Field label="Cold-chain package" required><Select required value={packageId} onChange={e => setPackageId(e.target.value)}><option value="">Choose package</option>{(packages.data ?? []).map(p => <option key={p.package_id} value={p.package_id}>{p.package_number} · {p.order_number}</option>)}</Select></Field>
      <Field label="When" required><Select value={stage} onChange={e => setStage(e.target.value as TemperatureStage)}>{TEMPERATURE_STAGES.map(s => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}</Select></Field>
      <Field label="Temperature (°C)" required><Input required type="number" step="0.1" min={-60} max={60} value={temperature} onChange={e => setTemperature(e.target.value)} /></Field>
      <Field label="Note"><Input maxLength={500} value={note} onChange={e => setNote(e.target.value)} /></Field>
      <div className="sm:col-span-4"><Button type="submit" disabled={busy || !packageId || temperature === ''}>Record temperature</Button></div>
    </form></CardBody></Card>}
    <h2 className="mb-2 mt-6 font-semibold">Excursions</h2>
    <Card><DataTable caption="Temperature excursions" columns={excursionColumns} rows={excursions.data ?? []} rowKey={x => x.id} loading={excursions.isFetching} error={excursions.isError ? toAppError(excursions.error).message : null} onRetry={() => void excursions.refetch()} emptyTitle="No excursions" emptyDescription="An out-of-range reading appears here until it is decided." /></Card>
    <h2 className="mb-2 mt-6 font-semibold">Cold-chain packages</h2>
    <Card><DataTable caption="Cold-chain packages" columns={packageColumns} rows={packages.data ?? []} rowKey={p => p.package_id} loading={packages.isFetching} error={packages.isError ? toAppError(packages.error).message : null} onRetry={() => void packages.refetch()} emptyTitle="No cold-chain packages" emptyDescription="Packages marked cold chain while packing appear here." /></Card>
  </>
}
