import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Badge, Button, Card, CardBody, Field, InlineError, Input, Select } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { STAGE_LABEL, listRunColdPackages, recordRunTemperature } from '@/services/temperature'

/** Cold-chain packages on a run, with their latest temperature, and a form to record one from the road. */
export function RunTemperaturePanel({ runId, canRecord }: { runId: string; canRecord: boolean }) {
  const qc = useQueryClient()
  const packages = useQuery({ queryKey: ['run-cold', runId], queryFn: () => listRunColdPackages(runId), refetchInterval: 20_000 })
  const [packageId, setPackageId] = useState('')
  const [stage, setStage] = useState<'TRANSIT' | 'DELIVERY'>('TRANSIT')
  const [temperature, setTemperature] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const rows = packages.data ?? []
  if (!packages.isLoading && !packages.isError && rows.length === 0) return null

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const r = await recordRunTemperature(runId, packageId, stage, Number(temperature), note)
      setNotice(r.within_range
        ? `Recorded ${temperature} °C: within the ${r.limit_min_c} to ${r.limit_max_c} °C range.`
        : `Recorded ${temperature} °C: OUTSIDE the ${r.limit_min_c} to ${r.limit_max_c} °C range. Do not hand these goods over until the warehouse has decided; tell the dispatcher now.`)
      setTemperature(''); setNote('')
      await Promise.all(['run-cold', 'cold-packages', 'temperature-readings', 'temperature-excursions'].map(k => qc.invalidateQueries({ queryKey: [k] })))
    } catch (err) { setError(toAppError(err).message) } finally { setBusy(false) }
  }

  return <Card><CardBody>
    <h2 className="font-semibold">Cold-chain temperatures</h2>
    <InlineError message={packages.isError ? toAppError(packages.error).message : null} />
    <ul className="my-3 space-y-2">{rows.map(p => <li key={p.package_id} className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-mono text-xs font-semibold">{p.package_number}</span><span>Stop {p.stop_position} · {p.customer_name}</span>
      {p.latest_temperature_c == null ? <span className="text-slate-500">No reading yet</span> : <span>{p.latest_temperature_c} °C ({STAGE_LABEL[p.latest_stage ?? ''] ?? p.latest_stage}, {formatDateTime(p.latest_recorded_at)}) <Badge tone={p.latest_within_range ? 'green' : 'red'}>{p.latest_within_range ? 'In range' : 'Out of range'}</Badge></span>}
      {p.open_excursions > 0 && <Badge tone="red">Excursion: do not hand over</Badge>}
    </li>)}</ul>
    {notice && <p role="status" className="mb-3">{notice}</p>}
    <InlineError message={error} />
    {canRecord && <form className="grid gap-3 sm:grid-cols-4" onSubmit={e => void submit(e)}>
      <Field label="Package" required><Select required value={packageId} onChange={e => setPackageId(e.target.value)}><option value="">Choose package</option>{rows.map(p => <option key={p.package_id} value={p.package_id}>{p.package_number} · stop {p.stop_position}</option>)}</Select></Field>
      <Field label="When" required><Select value={stage} onChange={e => setStage(e.target.value as 'TRANSIT' | 'DELIVERY')}><option value="TRANSIT">{STAGE_LABEL.TRANSIT}</option><option value="DELIVERY">{STAGE_LABEL.DELIVERY}</option></Select></Field>
      <Field label="Temperature (°C)" required><Input required type="number" step="0.1" min={-60} max={60} value={temperature} onChange={e => setTemperature(e.target.value)} /></Field>
      <Field label="Note"><Input maxLength={500} value={note} onChange={e => setNote(e.target.value)} /></Field>
      <div className="sm:col-span-4 print:hidden"><Button type="submit" disabled={busy || !packageId || temperature === ''}>Record temperature</Button></div>
    </form>}
  </CardBody></Card>
}
