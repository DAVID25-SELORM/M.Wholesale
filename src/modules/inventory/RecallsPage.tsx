import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { recallCustomerExposure } from '@/services/recalls'
import { Badge, Button, Card, CardBody, DataTable, Field, InlineError, Input, PageHeader, Select, Textarea, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import { addRecallBatch, closeRecall, createRecall, listRecalls, listRecallScope, quarantineRecallBatch, recallBatchOptions, type RecallRow } from '@/services/recalls'

export function RecallsPage() {
  const qc = useQueryClient()
  const { ability } = useSession()
  const canManage = ability.can('recalls.manage')
  const query = useQuery({ queryKey: ['recalls'], queryFn: listRecalls })
  const [selected, setSelected] = useState('')
  const [creating, setCreating] = useState(false)
  const [source, setSource] = useState('INTERNAL')
  const [recallClass, setRecallClass] = useState('II')
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const [batch, setBatch] = useState('')
  const [search, setSearch] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const scope = useQuery({ queryKey: ['recall-scope', selected], queryFn: () => listRecallScope(selected), enabled: !!selected })
  const options = useQuery({ queryKey: ['recall-batches'], queryFn: recallBatchOptions, enabled: !!selected })
  const exposure = useQuery({ queryKey: ['recall-exposure', selected], queryFn: () => recallCustomerExposure(selected), enabled: !!selected })
  const recall = query.data?.find(r => r.id === selected)
  const active = recall && ['OPEN', 'QUARANTINED'].includes(recall.status)
  async function act(action: () => Promise<unknown>) {
    if (busy) return
    setBusy(true); setError(null)
    try {
      await action()
      await qc.invalidateQueries({ queryKey: ['recall-exposure'] })
      await Promise.all([qc.invalidateQueries({ queryKey: ['recalls'] }), qc.invalidateQueries({ queryKey: ['recall-scope'] }), qc.invalidateQueries({ queryKey: ['stock'] })])
    } catch (e) { setError(toAppError(e).message) } finally { setBusy(false) }
  }
  function submit(e: FormEvent) {
    e.preventDefault()
    void act(async () => {
      const id = await createRecall(source, recallClass, title.trim(), instructions.trim())
      setSelected(id); setCreating(false); setTitle(''); setInstructions('')
    })
  }
  const columns: Column<RecallRow>[] = [
    { key: 'number', header: 'Recall', render: r => <Button variant="ghost" onClick={() => { setSelected(r.id); setBatch(''); setError(null) }}>{r.recall_number}</Button> },
    { key: 'title', header: 'Title', render: r => r.title },
    { key: 'source', header: 'Source', render: r => r.source + ' / Class ' + r.recall_class },
    { key: 'status', header: 'Status', render: r => <Badge tone={r.status === 'CLOSED' ? 'green' : 'amber'}>{r.status}</Badge> },
  ]
  return <>
    <PageHeader title="Recalls" description="Select a recall to review its affected batches and quarantine progress." actions={canManage && <Button onClick={() => setCreating(!creating)} disabled={busy}>New recall</Button>} />
    <InlineError message={error} />
    {creating && canManage && <Card><CardBody><form onSubmit={submit} className="space-y-3">
      <Field label="Source"><Select value={source} onChange={e => setSource(e.target.value)}>{['FDA', 'MANUFACTURER', 'SUPPLIER', 'INTERNAL', 'OTHER'].map(s => <option key={s}>{s}</option>)}</Select></Field>
      <Field label="Recall class"><Select value={recallClass} onChange={e => setRecallClass(e.target.value)}>{['I', 'II', 'III', 'OTHER'].map(s => <option key={s}>{s}</option>)}</Select></Field>
      <Field label="Title" required><Input required minLength={3} maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></Field>
      <Field label="Instructions" required><Textarea required minLength={3} maxLength={2000} value={instructions} onChange={e => setInstructions(e.target.value)} /></Field>
      <Button type="submit" loading={busy}>Create recall</Button>
    </form></CardBody></Card>}
    <Card><DataTable caption="Product recalls" columns={columns} rows={query.data ?? []} rowKey={r => r.id} loading={query.isFetching} error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()} emptyTitle="No recalls" emptyDescription="Authorized staff can create a recall above." /></Card>
    {recall && <Card><CardBody><div className="space-y-4">
      <h2 className="text-lg font-semibold">{recall.recall_number}: {recall.title}</h2>
      <p className="whitespace-pre-wrap">{recall.instructions}</p>
      <InlineError message={scope.isError ? toAppError(scope.error).message : options.isError ? toAppError(options.error).message : null} />
      {canManage && active && <>
        <Field label="Search batches"><Input value={search} onChange={e => setSearch(e.target.value)} /></Field>
        <Field label="Affected batch"><Select value={batch} onChange={e => setBatch(e.target.value)}><option value="">Choose a product and batch</option>{options.data?.filter(b => (b.sku + ' ' + b.product_name + ' ' + b.batch_number).toLowerCase().includes(search.toLowerCase()) && !scope.data?.some(s => s.batch_id === b.id)).map(b => <option key={b.id} value={b.id}>{b.sku} / {b.product_name} / {b.batch_number} / {b.expiry_date}</option>)}</Select></Field>
        <Button disabled={busy || !batch || scope.isPending} onClick={() => void act(async () => { await addRecallBatch(selected, batch); setBatch('') })}>Add batch to this recall</Button>
        <Field label="Quarantine reason" hint="Required before quarantining a batch (5 to 500 characters)."><Textarea minLength={5} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></Field>
      </>}
      {scope.isPending ? <p>Loading affected batches...</p> : <ul className="space-y-3">{scope.data?.map(s => {
        const b = options.data?.find(x => x.id === s.batch_id)
        return <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 border-b py-2"><span>{b ? b.product_name + ' / ' + b.batch_number : s.batch_id} — {s.quarantined_at ? 'Quarantine recorded' : 'Awaiting quarantine'}</span>{canManage && active && <Button disabled={busy || reason.trim().length < 5} onClick={() => void act(() => quarantineRecallBatch(s.id, reason.trim()))}>{s.quarantined_at ? 'Quarantine new stock' : 'Quarantine batch'}</Button>}</li>
      })}</ul>}
      {canManage && active && <Button variant="secondary" disabled={busy || !scope.data?.length || scope.data.some(s => !s.quarantined_at)} onClick={() => void act(() => closeRecall(selected))}>Close recall</Button>}
      <h3 className="font-semibold">Affected customer transactions</h3>
      <p className="text-sm">Original allocations and approved substitutions are shown separately for investigation. These are base-unit quantities, not confirmed customer recovery totals.</p>
      <InlineError message={exposure.isError ? toAppError(exposure.error).message : null} />
      {exposure.isPending ? <p>Loading customer trace...</p> : exposure.data?.length ? <ul className="space-y-3">{exposure.data.map((x, i) => <li key={`${x.invoice_id}-${x.batch_id}-${x.source}-${i}`} className="border-b py-2">
        <p className="font-medium">{x.customer_name} / {x.invoice_number}</p>
        <p>{x.product_name} / {x.batch_number} / {x.quantity} base units / {x.delivery_status}</p>
        <p className="text-sm">{x.source === 'APPROVED_SUBSTITUTION' ? 'Approved replacement batch' : 'Original invoice allocation'} · {[x.contact_name, x.phone, x.email].filter(Boolean).join(' / ') || 'No contact details recorded'}</p>
        {ability.can('sales.view') && <Link className="text-brand-700 underline" to={`/sales/invoices/${x.invoice_id}`}>Open invoice</Link>}
      </li>)}</ul> : !exposure.isError && <p>No posted customer transactions found for the scoped batches.</p>}
    </div></CardBody></Card>}
  </>
}
