import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, CardBody, DataTable, LoadingState, Modal, PageHeader, Pagination, Select, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { useAuth } from '@/modules/auth/AuthProvider'
import { useSession } from '@/modules/session/SessionProvider'
import { supabase } from '@/lib/supabase'
import { getSessionSummary, listPosSales, listPosSessions, type PosSession } from '@/services/pos'
import { RECEIPT_METHOD_LABEL, moneyFmt } from '@/services/sales'
import { CloseShiftDialog } from './PosPage'

const PAGE_SIZE = 20

async function cashierNames(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {}
  const { data } = await supabase.from('profiles').select('id, first_name, last_name').in('id', ids)
  return Object.fromEntries((data ?? []).map((p) => [p.id, [p.first_name, p.last_name].filter(Boolean).join(' ')]))
}

export function PosSessionsPage() {
  const { ability } = useSession()
  const { auth } = useAuth()
  const me = auth.status === 'signedIn' ? auth.session.user.id : ''
  const [page, setPage] = useState(0)
  const [status, setStatus] = useState<'OPEN' | 'CLOSED' | ''>('')
  const [varianceOnly, setVarianceOnly] = useState(false)
  const [viewing, setViewing] = useState<PosSession | null>(null)
  const [closing, setClosing] = useState<PosSession | null>(null)
  const params = { page, pageSize: PAGE_SIZE, status, varianceOnly }
  const query = useQuery({ queryKey: ['pos-sessions', params], queryFn: () => listPosSessions(params), placeholderData: (p) => p })
  const ids = [...new Set((query.data?.rows ?? []).map((s) => s.cashier_id))]
  const names = useQuery({ queryKey: ['cashier-names', ids], queryFn: () => cashierNames(ids), enabled: ids.length > 0, staleTime: 60_000 })

  const columns: Column<PosSession>[] = [
    { key: 'no', header: 'Shift', render: (s) => <button type="button" onClick={() => setViewing(s)} className="font-mono text-xs font-semibold text-brand-700 hover:underline">{s.session_number}</button> },
    { key: 'who', header: 'Cashier', render: (s) => (s.cashier_id === me ? 'You' : names.data?.[s.cashier_id] || 'Cashier') },
    { key: 'wh', header: 'Store', hideOnMobile: true, render: (s) => s.warehouse?.name ?? '—' },
    { key: 'open', header: 'Opened', hideOnMobile: true, render: (s) => <span className="whitespace-nowrap text-slate-600">{formatDateTime(s.opened_at)}</span> },
    { key: 'status', header: 'Status', render: (s) => (s.status === 'OPEN' ? <Badge tone="green">Open</Badge> : <Badge>Closed</Badge>) },
    { key: 'sales', header: 'Sales', className: 'text-right', render: (s) => (s.status === 'CLOSED' ? <span className="tabular-nums">{moneyFmt(s.sales_total)}</span> : '—') },
    {
      key: 'var', header: 'Cash difference', className: 'text-right',
      render: (s) => s.status !== 'CLOSED' ? '—' : Number(s.variance) === 0 ? <span className="text-green-700">Balanced</span> : <span className={`tabular-nums font-semibold ${Number(s.variance) < 0 ? 'text-red-700' : 'text-amber-700'}`}>{Number(s.variance) > 0 ? '+' : ''}{moneyFmt(s.variance)}</span>,
    },
    { key: 'act', header: '', className: 'text-right', render: (s) => (s.status === 'OPEN' && s.cashier_id !== me && ability.can('pos.manage', s.branch_id) ? <Button size="sm" variant="secondary" onClick={() => setClosing(s)}>Close</Button> : null) },
  ]

  return (
    <>
      <PageHeader title="Till shifts" description="Every shift with the cash counted against the cash expected." actions={ability.canAnywhere('pos.sell') && <Link to="/pos"><Button>Open the till</Button></Link>} />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center">
          <div className="w-full sm:w-44">
            <label htmlFor="sh-status" className="sr-only">Status</label>
            <Select id="sh-status" value={status} onChange={(e) => { setStatus(e.target.value as 'OPEN' | 'CLOSED' | ''); setPage(0) }}><option value="">All shifts</option><option value="OPEN">Open</option><option value="CLOSED">Closed</option></Select>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" className="h-4 w-4" checked={varianceOnly} onChange={(e) => { setVarianceOnly(e.target.checked); setPage(0) }} /> Only shifts where the cash was off</label>
        </div>
        <DataTable
          caption="Till shifts" columns={columns} rows={query.data?.rows} rowKey={(s) => s.id} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()} emptyTitle="No shifts yet" emptyDescription="Shifts appear here once a cashier opens the till."
        />
        <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>
      {viewing && <ShiftDetail session={viewing} onClose={() => setViewing(null)} />}
      {closing && <CloseShiftDialog session={closing} onClose={() => setClosing(null)} onClosed={() => undefined} />}
    </>
  )
}

function ShiftDetail({ session, onClose }: { session: PosSession; onClose: () => void }) {
  const summary = useQuery({ queryKey: ['pos-summary', session.id], queryFn: () => getSessionSummary(session.id) })
  const sales = useQuery({ queryKey: ['pos-sales', session.id], queryFn: () => listPosSales(session.id) })
  return (
    <Modal open size="lg" onClose={onClose} title={`Shift ${session.session_number}`} description={`${session.warehouse?.name ?? ''} · opened ${formatDateTime(session.opened_at)}`} footer={<Button onClick={onClose}>Close</Button>}>
      {summary.isPending || sales.isPending ? <LoadingState /> : (
        <div className="space-y-4">
          {summary.data && (
            <dl className="grid gap-3 sm:grid-cols-4">
              {([['Sales', `${summary.data.sales_count} · ${moneyFmt(summary.data.sales_total)}`], ['Opening float', moneyFmt(summary.data.opening_float)], ['Cash expected', moneyFmt(summary.data.expected_cash)], ['Cash counted', session.status === 'CLOSED' ? moneyFmt(session.counted_cash) : '—']] as [string, string][]).map(([k, v]) => (
                <div key={k}><dt className="text-xs uppercase tracking-wide text-slate-500">{k}</dt><dd className="font-semibold tabular-nums">{v}</dd></div>
              ))}
            </dl>
          )}
          {summary.data && summary.data.by_method.length > 0 && <p className="text-sm text-slate-600">{summary.data.by_method.map((m) => `${RECEIPT_METHOD_LABEL[m.method]} ${moneyFmt(m.amount)}`).join(' · ')}</p>}
          {session.close_notes && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{session.close_notes}</p>}
          <Card>
            <CardBody className="p-0">
              <ul className="divide-y divide-slate-100 text-sm">
                {(sales.data ?? []).length === 0 && <li className="px-3 py-3 text-slate-500">No sales in this shift.</li>}
                {(sales.data ?? []).map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span><Link to={`/sales/invoices/${s.sales_invoice_id}`} className="font-mono text-xs font-semibold text-brand-700 hover:underline">{s.invoice?.invoice_number}</Link> <span className="text-slate-500">{s.customer?.name} · {formatDateTime(s.created_at)}</span></span>
                    <span className="tabular-nums">{moneyFmt(s.total_amount)}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
      )}
    </Modal>
  )
}
