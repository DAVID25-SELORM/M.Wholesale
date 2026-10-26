import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useState } from 'react'
import { Badge, Button, Card, CardBody, DataTable, Field, InlineError, PageHeader, Select, Textarea, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { useSession } from '@/modules/session/SessionProvider'
import { acceptShort, getOpenFulfilmentExceptions, holdOrder, shipShort, substitutionBatchOptions, substituteBatch, type FulfilmentExceptionRow } from '@/services/exceptions'

type Mode = 'accept' | 'ship' | 'hold' | 'substitute'
const labels: Record<Mode, string> = { accept: 'Accept short', ship: 'Ship short and draft credit', hold: 'Hold order', substitute: 'Substitute batch' }
export function ExceptionsPage() {
  const qc = useQueryClient()
  const { ability } = useSession()
  const query = useQuery({ queryKey: ['fulfilment-exceptions-open'], queryFn: getOpenFulfilmentExceptions, refetchInterval: 30_000 })
  const [action, setAction] = useState<{ row: FulfilmentExceptionRow; mode: Mode } | null>(null)
  const [reason, setReason] = useState('')
  const [batch, setBatch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [credit, setCredit] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const options = useQuery({ queryKey: ['substitution-options', action?.row.id], queryFn: () => substitutionBatchOptions(action!.row.id), enabled: action?.mode === 'substitute' })
  const open = (row: FulfilmentExceptionRow, mode: Mode) => { setAction({ row, mode }); setReason(''); setBatch(''); setError(null); setNotice(null) }
  async function submit() {
    if (!action || busy) return
    setBusy(true); setError(null)
    try {
      const { row, mode } = action
      if (mode === 'ship') setCredit(await shipShort(row.id, reason.trim()))
      else if (mode === 'hold') await holdOrder(row.fulfilment_order_id, reason.trim())
      else if (mode === 'substitute') {
        const choice = options.data?.find(b => b.stock_balance_id === batch)
        if (!choice) throw new Error('Choose a replacement stock location')
        await substituteBatch(row.id, choice.id, reason.trim(), choice.stock_balance_id)
        setNotice(options.data?.find(b => b.stock_balance_id === batch)?.is_controlled ? 'Request sent to Controlled adjustments for independent approval.' : 'Batch substitution recorded.')
      } else await acceptShort(row.id, reason.trim())
      setAction(null)
      await Promise.all(['fulfilment-exceptions-open', 'fulfilment-queue', 'fulfilment-order', 'fulfilment-lines', 'substitution-options'].map(k => qc.invalidateQueries({ queryKey: [k] })))
    } catch (e) { setError(toAppError(e).message) } finally { setBusy(false) }
  }
  const columns: Column<FulfilmentExceptionRow>[] = [
    { key: 'order', header: 'Order', render: r => <Link to={`/warehouse/picking/${r.fulfilment_order_id}`} className="text-brand-700 hover:underline">Open order</Link> },
    { key: 'qty', header: 'Short quantity', render: r => r.short_quantity },
    { key: 'reason', header: 'Reason', render: r => <Badge tone="red">{r.reason}</Badge> },
    { key: 'raised', header: 'Raised', render: r => formatDateTime(r.raised_at) },
    { key: 'actions', header: 'Decision', render: r => <div className="flex flex-wrap gap-2">{(Object.keys(labels) as Mode[]).filter(mode => mode === 'accept' ? ability.can('picking.assign', r.branch_id) : ability.can('fulfilment.exception', r.branch_id) && (mode !== 'ship' || ability.can('credit_notes.create', r.branch_id))).map(mode => <Button key={mode} size="sm" variant="secondary" disabled={busy} onClick={() => open(r, mode)}>{labels[mode]}</Button>)}</div> },
  ]
  return <>
    <PageHeader title="Fulfilment exceptions" description="Review short picks, replace an outstanding short quantity, or hold an order." />
    <InlineError message={error} />
    {notice && <p role="status" className="mb-4">{notice}</p>}
    {credit && <p role="status" className="mb-4">A draft credit was created. Finance must review and post it. <Link className="text-brand-700 underline" to={`/sales/credit-notes/${credit}`}>Open draft credit</Link></p>}
    {action && <Card><CardBody><form className="space-y-3" onSubmit={e => { e.preventDefault(); void submit() }}>
      <h2 className="font-semibold">{labels[action.mode]}</h2>
      {action.mode === 'substitute' && <>
        <p className="text-sm">Replace the short quantity, selecting the replacement batch and its stock location. Controlled products require independent approval.</p>
        <p className="text-sm">{['DAMAGED', 'EXPIRED'].includes(action.row.reason) ? 'The original short quantity will be recorded in quarantine. Confirm those goods are physically present before proceeding.' : 'The original short quantity will not be restored to stock. Investigate missing goods separately; this action deducts the replacement stock.'}</p>
        <InlineError message={options.isError ? toAppError(options.error).message : null} />
        <Field label="Replacement batch" required><Select required value={batch} onChange={e => setBatch(e.target.value)} disabled={options.isFetching || busy}><option value="">{options.isFetching ? 'Loading batches...' : 'Choose batch'}</option>{options.data?.map(b => <option key={b.stock_balance_id} value={b.stock_balance_id}>{b.batch_number} / {b.location_code} / expires {b.expiry_date} / available {b.available_quantity}</option>)}</Select></Field>
        {!options.isPending && !options.isError && !options.data?.length && <p>No eligible replacement batches have sufficient stock.</p>}
      </>}
      {action.mode === 'ship' && <p className="text-sm">Creates a draft credit with a quarantine return. Review the physical shortage and post the credit through Finance.</p>}
      <Field label="Reason" required><Textarea required minLength={action.mode === 'substitute' ? 5 : 3} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} disabled={busy} /></Field>
      <div className="flex gap-2"><Button type="submit" loading={busy} disabled={reason.trim().length < (action.mode === 'substitute' ? 5 : 3) || (action.mode === 'substitute' && !batch)}>Confirm</Button><Button variant="ghost" disabled={busy} onClick={() => setAction(null)}>Cancel</Button></div>
    </form></CardBody></Card>}
    <Card><DataTable caption="Open fulfilment exceptions" columns={columns} rows={query.data ?? []} rowKey={r => r.id} loading={query.isFetching} error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()} emptyTitle="No open exceptions" emptyDescription="Short picks appear here for supervisor review." /></Card>
  </>
}
