import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ClipboardList } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Badge, Button, Card, DataTable, Field, InlineError, Modal, PageHeader, Pagination, Select, Textarea, useToast, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { useSession } from '@/modules/session/SessionProvider'
import { listLocationOptions } from '@/services/inventory'
import {
  COUNT_STATUSES, COUNT_STATUS_LABEL, COUNT_STATUS_TONE, listStockCounts, startStockCount, type CountStatus, type StockCount,
} from '@/services/stockCounts'
import { listWarehouseOptions } from '@/services/warehouses'

const PAGE_SIZE = 20

export function StockCountsPage() {
  const { ability } = useSession()
  const navigate = useNavigate()
  const [page, setPage] = useState(0)
  const [status, setStatus] = useState<CountStatus | ''>('')
  const [starting, setStarting] = useState(false)
  const params = { page, pageSize: PAGE_SIZE, status }
  const query = useQuery({ queryKey: ['stock-counts', params], queryFn: () => listStockCounts(params), placeholderData: (prev) => prev })

  const columns: Column<StockCount>[] = [
    { key: 'no', header: 'Count', render: (c) => <Link to={`/inventory/counts/${c.id}`} className="font-mono text-xs font-semibold text-brand-700 hover:underline">{c.count_number}</Link> },
    { key: 'wh', header: 'Warehouse', render: (c) => <span>{c.warehouse?.name}{c.location ? <span className="text-slate-500"> · {c.location.code}</span> : null}</span> },
    { key: 'status', header: 'Status', render: (c) => <Badge tone={COUNT_STATUS_TONE[c.status as CountStatus] ?? 'blue'}>{COUNT_STATUS_LABEL[c.status as CountStatus] ?? c.status}</Badge> },
    { key: 'lines', header: 'Lines', hideOnMobile: true, className: 'text-right', render: (c) => <span className="tabular-nums">{c.line_count}</span> },
    { key: 'when', header: 'Started', render: (c) => <span className="whitespace-nowrap text-slate-600">{formatDateTime(c.created_at)}</span> },
  ]

  return (
    <>
      <PageHeader
        title="Stock counts"
        description="Count what is on the shelves, compare with the system, and post the differences after a second person approves."
        actions={ability.canAnywhere('inventory.count') && <Button onClick={() => setStarting(true)}><ClipboardList className="h-4 w-4" aria-hidden /> Start a count</Button>}
      />
      <Card>
        <div className="border-b border-slate-100 p-4">
          <div className="w-full sm:w-60">
            <label htmlFor="count-status" className="sr-only">Status</label>
            <Select id="count-status" value={status} onChange={(e) => { setStatus(e.target.value as CountStatus | ''); setPage(0) }}>
              <option value="">All counts</option>
              {COUNT_STATUSES.map((s) => <option key={s} value={s}>{COUNT_STATUS_LABEL[s]}</option>)}
            </Select>
          </div>
        </div>
        <DataTable
          caption="Stock counts" columns={columns} rows={query.data?.rows} rowKey={(c) => c.id} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()}
          emptyTitle="No stock counts yet" emptyDescription="Start a count for a warehouse or a single shelf location."
        />
        <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>
      {starting && <StartDialog onClose={() => setStarting(false)} onStarted={(id) => navigate(`/inventory/counts/${id}`)} />}
    </>
  )
}

function StartDialog({ onClose, onStarted }: { onClose: () => void; onStarted: (id: string) => void }) {
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const warehouses = useQuery({ queryKey: ['warehouse-options', null], queryFn: () => listWarehouseOptions(null), staleTime: 60_000 })
  const [warehouseId, setWarehouseId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const locations = useQuery({ queryKey: ['location-options', warehouseId], queryFn: () => listLocationOptions(warehouseId), enabled: Boolean(warehouseId) })
  const mine = (warehouses.data ?? []).filter((w) => w.is_active && ability.can('inventory.count', w.branch_id))

  const start = useMutation({
    mutationFn: () => startStockCount({ warehouseId, locationId, notes }),
    onSuccess: async (id) => { toast.success('Count started.'); await qc.invalidateQueries({ queryKey: ['stock-counts'] }); onStarted(id); onClose() },
    onError: (e) => setError(toAppError(e).message),
  })
  function submit(e: FormEvent) {
    e.preventDefault()
    if (!warehouseId) { setError('Choose the warehouse to count.'); return }
    setError(null)
    start.mutate()
  }
  return (
    <Modal
      open size="md" onClose={onClose} title="Start a stock count"
      description="The system quantities are frozen as a snapshot now. Anything that moves while you count is still applied correctly at approval."
      footer={<><Button variant="secondary" onClick={onClose} disabled={start.isPending}>Cancel</Button><Button type="submit" form="count-form" loading={start.isPending}>Start counting</Button></>}
    >
      <form id="count-form" onSubmit={submit} noValidate className="space-y-3">
        <InlineError message={error} />
        <Field label="Warehouse" required>
          <Select value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setLocationId('') }}>
            <option value="">Select…</option>
            {mine.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
        </Field>
        <Field label="Only this location" hint="Leave blank to count the whole warehouse. Large warehouses (over 5,000 stock lines) must be counted location by location.">
          <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={!warehouseId}>
            <option value="">Whole warehouse</option>
            {(locations.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}
          </Select>
        </Field>
        <Field label="Notes"><Textarea rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </form>
    </Modal>
  )
}
