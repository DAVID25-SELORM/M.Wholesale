import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Badge, Button, Card, CardBody, EmptyState, ErrorState, Input, LoadingState, PageHeader, Select, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { ReasonDialog } from '@/modules/purchasing/shared'
import { useSession } from '@/modules/session/SessionProvider'
import { fmtQty } from '@/services/inventory'
import {
  COUNT_STATUS_LABEL, COUNT_STATUS_TONE, approveStockCount, cancelStockCount, getStockCount, lineVariance, listCountLines, returnStockCount,
  saveCountEntries, submitStockCount, type CountStatus,
} from '@/services/stockCounts'
import { StockStatusBadge } from './shared'

const PAGE = 100
type Filter = 'all' | 'uncounted' | 'variances'
type Reason = 'return' | 'cancel' | null

export function StockCountDetailPage() {
  const { id = '' } = useParams()
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const count = useQuery({ queryKey: ['stock-count', id], queryFn: () => getStockCount(id), enabled: Boolean(id) })
  const lines = useQuery({ queryKey: ['stock-count-lines', id], queryFn: () => listCountLines(id), enabled: Boolean(id) })
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState(0)
  const [reason, setReason] = useState<Reason>(null)
  const [reasonError, setReasonError] = useState<string | null>(null)

  const refresh = () => Promise.all(['stock-count', 'stock-count-lines', 'stock-counts', 'stock', 'balances', 'stock-documents'].map((k) => qc.invalidateQueries({ queryKey: [k] })))

  const save = useMutation({
    mutationFn: async () => {
      const entries = Object.entries(edits).map(([line_id, v]) => ({ line_id, counted_quantity: v.trim() === '' ? null : Number(v) }))
      if (entries.some((e) => e.counted_quantity !== null && (!Number.isFinite(e.counted_quantity) || e.counted_quantity < 0))) throw new Error('Counted quantities must be 0 or more.')
      return saveCountEntries(id, entries)
    },
    onSuccess: async (n) => { toast.success(`${n} ${n === 1 ? 'entry' : 'entries'} saved.`); setEdits({}); await refresh() },
    onError: (e) => toast.error(toAppError(e).message),
  })
  const simple = useMutation({
    mutationFn: async (kind: 'submit' | 'approve') => {
      if (kind === 'submit') { await submitStockCount(id); return null }
      return approveStockCount(id)
    },
    onSuccess: async (r) => {
      toast.success(r ? (r.variances === 0 ? 'Approved - no differences to post.' : `Approved - ${r.variances} difference(s) posted as ${r.stock_document_number}.`) : 'Submitted for approval.')
      await refresh()
    },
    onError: (e) => toast.error(toAppError(e).message),
  })
  const withReason = useMutation({
    mutationFn: (v: { kind: Exclude<Reason, null>; text: string }) => (v.kind === 'return' ? returnStockCount(id, v.text) : cancelStockCount(id, v.text)),
    onSuccess: async () => { setReason(null); setReasonError(null); toast.success('Done.'); await refresh() },
    onError: (e) => setReasonError(toAppError(e).message),
  })

  const rows = useMemo(() => lines.data ?? [], [lines.data])
  const shown = useMemo(() => {
    const value = (l: (typeof rows)[number]) => (edits[l.id] !== undefined ? (edits[l.id]!.trim() === '' ? null : Number(edits[l.id])) : l.counted_quantity === null ? null : Number(l.counted_quantity))
    return rows.filter((l) => {
      const v = value(l)
      if (filter === 'uncounted') return v === null
      if (filter === 'variances') return v !== null && v !== Number(l.system_quantity)
      return true
    })
  }, [rows, edits, filter])

  if (count.isPending) return <LoadingState />
  if (count.isError) return <ErrorState message={toAppError(count.error).message} onRetry={() => void count.refetch()} />
  const c = count.data
  if (!c) return <EmptyState title="Count not found" description="It may belong to another branch." action={<Link className="text-sm font-medium text-brand-700 hover:underline" to="/inventory/counts">Back to counts</Link>} />

  const status = c.status as CountStatus
  const canCount = ability.can('inventory.count', c.branch_id)
  const canApprove = ability.can('inventory.count_approve', c.branch_id)
  const editable = status === 'OPEN' && canCount
  const counted = rows.filter((l) => l.counted_quantity !== null).length
  const variances = rows.filter((l) => { const v = lineVariance(l); return v !== null && v !== 0 }).length
  const dirty = Object.keys(edits).length > 0
  const pageRows = shown.slice(page * PAGE, page * PAGE + PAGE)

  const reasonText = {
    return: { title: 'Send back for recount', description: 'The counter will see your reason and can correct the entries.', confirm: 'Send back', tone: 'primary' as const },
    cancel: { title: 'Cancel this count', description: 'Nothing is posted to stock. The count cannot be reopened.', confirm: 'Cancel count', tone: 'danger' as const },
  }

  return (
    <>
      <Link to="/inventory/counts" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" aria-hidden /> Stock counts</Link>
      <PageHeader
        title={c.count_number}
        description={`${c.warehouse?.name ?? ''}${c.location ? ` · ${c.location.code}` : ' · whole warehouse'} · started ${formatDateTime(c.created_at)}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {status === 'OPEN' && canCount && (
              <>
                <Button variant="secondary" onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>Save entries</Button>
                <Button onClick={() => simple.mutate('submit')} loading={simple.isPending} disabled={dirty || counted === 0}>Submit for approval</Button>
                <Button variant="ghost" onClick={() => setReason('cancel')}>Cancel count</Button>
              </>
            )}
            {status === 'SUBMITTED' && canApprove && (
              <>
                <Button onClick={() => simple.mutate('approve')} loading={simple.isPending}>Approve and post differences</Button>
                <Button variant="secondary" onClick={() => setReason('return')}>Send back</Button>
                <Button variant="ghost" onClick={() => setReason('cancel')}>Cancel count</Button>
              </>
            )}
          </div>
        }
      />
      <Card>
        <CardBody>
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={COUNT_STATUS_TONE[status] ?? 'blue'}>{COUNT_STATUS_LABEL[status] ?? status}</Badge>
            <span className="text-sm text-slate-600">{counted} of {rows.length} lines counted · <strong className={variances > 0 ? 'text-amber-700' : ''}>{variances}</strong> with a difference</span>
            {c.status_reason && <span className="rounded-md bg-amber-50 px-2 py-1 text-sm text-amber-900">{status === 'OPEN' ? 'Sent back: ' : status === 'CANCELLED' ? 'Cancelled: ' : ''}{c.status_reason}</span>}
          </div>
          {status === 'OPEN' && <p className="mt-2 text-xs text-slate-500">Leave a line blank if you did not count it - it will not be adjusted. Differences are posted only when a second person approves.</p>}
        </CardBody>
      </Card>

      <div className="mt-5">
        <Card>
          <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center">
            <div className="w-full sm:w-56">
              <label htmlFor="count-filter" className="sr-only">Show</label>
              <Select id="count-filter" value={filter} onChange={(e) => { setFilter(e.target.value as Filter); setPage(0) }}>
                <option value="all">All lines</option>
                <option value="uncounted">Not counted yet</option>
                <option value="variances">With a difference</option>
              </Select>
            </div>
            <p className="text-sm text-slate-500 sm:ml-auto">{shown.length} {shown.length === 1 ? 'line' : 'lines'}</p>
          </div>
          {lines.isPending ? <LoadingState /> : lines.isError ? <ErrorState message={toAppError(lines.error).message} onRetry={() => void lines.refetch()} /> : pageRows.length === 0 ? (
            <EmptyState title="No lines match" />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <caption className="sr-only">Count lines</caption>
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr><th className="px-4 py-2.5">Location</th><th className="px-4 py-2.5">Product</th><th className="hidden px-4 py-2.5 md:table-cell">Batch</th><th className="hidden px-4 py-2.5 md:table-cell">Status</th><th className="px-4 py-2.5 text-right">System</th><th className="px-4 py-2.5 text-right">Counted</th><th className="px-4 py-2.5 text-right">Difference</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {pageRows.map((l) => {
                    const entered = edits[l.id]
                    const counted = entered !== undefined ? (entered.trim() === '' ? null : Number(entered)) : l.counted_quantity === null ? null : Number(l.counted_quantity)
                    const diff = counted === null || Number.isNaN(counted) ? null : Math.round((counted - Number(l.system_quantity)) * 1000) / 1000
                    return (
                      <tr key={l.id}>
                        <td className="px-4 py-2 font-mono text-xs">{l.location?.code ?? '—'}</td>
                        <td className="px-4 py-2"><span className="font-medium text-slate-900">{l.product?.brand_name}</span> <span className="font-mono text-xs text-slate-500">{l.product?.sku}</span></td>
                        <td className="hidden px-4 py-2 font-mono text-xs md:table-cell">{l.batch ? `${l.batch.batch_number} · ${l.batch.expiry_date}` : '—'}</td>
                        <td className="hidden px-4 py-2 md:table-cell"><StockStatusBadge status={l.stock_status} /></td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtQty(Number(l.system_quantity))}</td>
                        <td className="px-4 py-2 text-right">
                          {editable ? (
                            <Input
                              aria-label={`Counted quantity for ${l.product?.brand_name} ${l.batch?.batch_number ?? ''}`} type="number" inputMode="decimal" min="0" step="any"
                              className="ml-auto h-8 w-28 text-right" value={entered ?? (l.counted_quantity === null ? '' : String(Number(l.counted_quantity)))}
                              onChange={(e) => setEdits((x) => ({ ...x, [l.id]: e.target.value }))}
                            />
                          ) : <span className="tabular-nums">{l.counted_quantity === null ? '—' : fmtQty(Number(l.counted_quantity))}</span>}
                        </td>
                        <td className={`px-4 py-2 text-right font-semibold tabular-nums ${diff === null || diff === 0 ? 'text-slate-400' : diff < 0 ? 'text-red-700' : 'text-green-700'}`}>{diff === null ? '' : diff === 0 ? '0' : `${diff > 0 ? '+' : ''}${fmtQty(diff)}`}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {shown.length > PAGE && (
            <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm text-slate-500">
              <span>{page * PAGE + 1}–{Math.min(shown.length, (page + 1) * PAGE)} of {shown.length}</span>
              <span className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
                <Button size="sm" variant="secondary" disabled={(page + 1) * PAGE >= shown.length} onClick={() => setPage(page + 1)}>Next</Button>
              </span>
            </div>
          )}
        </Card>
      </div>
      {reason && (
        <ReasonDialog
          open title={reasonText[reason].title} description={reasonText[reason].description} confirmLabel={reasonText[reason].confirm}
          tone={reasonText[reason].tone} busy={withReason.isPending} error={reasonError}
          onConfirm={(text) => withReason.mutate({ kind: reason, text })} onClose={() => { setReason(null); setReasonError(null) }}
        />
      )}
    </>
  )
}
