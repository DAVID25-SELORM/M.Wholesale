import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Badge, Button, Card, DataTable, Field, InlineError, Input, LoadingState, Modal, PageHeader, Select, useToast, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { useAuth } from '@/modules/auth/AuthProvider'
import { useSession } from '@/modules/session/SessionProvider'
import {
  approveControlledAdjustment, cancelControlledAdjustment, listControlledAdjustments, productNames, rejectControlledAdjustment, type ControlledAdjustment, type RequestStatus,
} from '@/services/controlled'
import { REASON_LABEL, fmtQty } from '@/services/inventory'

const TONE: Record<RequestStatus, 'amber' | 'green' | 'red' | 'slate'> = { PENDING: 'amber', APPROVED: 'green', REJECTED: 'red', CANCELLED: 'slate' }
const LABEL: Record<RequestStatus, string> = { PENDING: 'Waiting for approval', APPROVED: 'Approved and posted', REJECTED: 'Rejected', CANCELLED: 'Withdrawn' }
const REFRESH = ['controlled-adjustments', 'stock', 'balances', 'stock-documents', 'movements', 'controlled-register', 'dashboard']

export function ControlledAdjustmentsPage() {
  const [status, setStatus] = useState<RequestStatus | ''>('PENDING')
  const [open, setOpen] = useState<ControlledAdjustment | null>(null)
  const query = useQuery({ queryKey: ['controlled-adjustments', status], queryFn: () => listControlledAdjustments(status) })

  const columns: Column<ControlledAdjustment>[] = [
    { key: 'no', header: 'Request', render: (r) => <button type="button" className="font-mono text-xs font-semibold text-brand-700 hover:underline" onClick={() => setOpen(r)}>{r.request_number}</button> },
    { key: 'wh', header: 'Warehouse', render: (r) => r.warehouse?.name ?? '—' },
    { key: 'reason', header: 'Reason', hideOnMobile: true, render: (r) => REASON_LABEL[r.reason_code] ?? r.reason_code },
    { key: 'lines', header: 'Lines', hideOnMobile: true, className: 'text-right', render: (r) => <span className="tabular-nums">{r.lines.length}</span> },
    { key: 'st', header: 'Status', render: (r) => <Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge> },
    { key: 'when', header: 'Requested', hideOnMobile: true, render: (r) => <span className="whitespace-nowrap text-slate-600">{formatDateTime(r.requested_at)}</span> },
  ]

  return (
    <>
      <PageHeader title="Controlled adjustments" description="Stock of a controlled medicine is never changed by one person. Someone requests the adjustment (Stock → Adjust stock); a second person with the approval right, usually the pharmacist, approves it, and only then is the stock document posted." />
      <Card>
        <div className="border-b border-slate-100 p-4 sm:w-64">
          <label htmlFor="ca-status" className="sr-only">Status</label>
          <Select id="ca-status" value={status} onChange={(e) => setStatus(e.target.value as RequestStatus | '')}>
            <option value="">All requests</option>{(Object.keys(LABEL) as RequestStatus[]).map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}
          </Select>
        </div>
        <DataTable caption="Controlled adjustment requests" columns={columns} rows={query.data} rowKey={(r) => r.id} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()}
          emptyTitle={status === 'PENDING' ? 'Nothing waiting for approval' : 'No requests'} emptyDescription="Requests appear here when someone asks to adjust a controlled medicine." />
      </Card>
      {open && <RequestDialog request={open} onClose={() => setOpen(null)} />}
    </>
  )
}

function RequestDialog({ request, onClose }: { request: ControlledAdjustment; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const { auth } = useAuth()
  const { ability } = useSession()
  const me = auth.status === 'signedIn' ? auth.session.user.id : ''
  const names = useQuery({ queryKey: ['product-names', request.id], queryFn: () => productNames([...new Set(request.lines.map((l) => l.product_id))]) })
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const pending = request.status === 'PENDING'
  const own = request.requested_by === me
  const canDecide = pending && !own && ability.can('inventory.controlled_approve', request.branch_id)
  const done = async (message: string) => { toast.success(message); await Promise.all(REFRESH.map((k) => qc.invalidateQueries({ queryKey: [k] }))); onClose() }
  const approve = useMutation({ mutationFn: () => approveControlledAdjustment(request.id), onSuccess: (r) => done(`Approved: ${r.document_number} posted.`), onError: (e) => setError(toAppError(e).message) })
  const reject = useMutation({ mutationFn: () => rejectControlledAdjustment(request.id, reason), onSuccess: () => done('Request rejected.'), onError: (e) => setError(toAppError(e).message) })
  const cancel = useMutation({ mutationFn: () => cancelControlledAdjustment(request.id), onSuccess: () => done('Request withdrawn.'), onError: (e) => setError(toAppError(e).message) })

  return (
    <Modal open size="lg" onClose={onClose} title={request.request_number} description={`${request.warehouse?.name ?? ''} · ${REASON_LABEL[request.reason_code] ?? request.reason_code} · ${formatDateTime(request.requested_at)}`}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {pending && own && <Button variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate()}>Withdraw request</Button>}
        {canDecide && !rejecting && <Button variant="danger" onClick={() => setRejecting(true)}>Reject…</Button>}
        {canDecide && rejecting && <Button variant="danger" loading={reject.isPending} onClick={() => { if (reason.trim().length < 5) { setError('Give a reason for rejecting.'); return } setError(null); reject.mutate() }}>Confirm rejection</Button>}
        {canDecide && !rejecting && <Button loading={approve.isPending} onClick={() => approve.mutate()}>Approve and post</Button>}
      </>}>
      <div className="space-y-3">
        <InlineError message={error} />
        <div className="flex flex-wrap items-center gap-2"><Badge tone={TONE[request.status]}>{LABEL[request.status]}</Badge>{pending && own && <span className="text-sm text-slate-600">You made this request: a second person has to approve it.</span>}{pending && !own && !canDecide && <span className="text-sm text-slate-600">Waiting for someone with the approval right.</span>}</div>
        <p className="text-sm text-slate-700"><span className="font-medium">Explanation:</span> {request.notes}</p>
        {request.decision_note && <p className="text-sm text-slate-700"><span className="font-medium">Decision note:</span> {request.decision_note}</p>}
        {names.isPending ? <LoadingState /> : (
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
            {request.lines.map((l, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-3 py-2">
                <span>{names.data?.get(l.product_id) ?? l.product_id}</span>
                <span className={`tabular-nums font-medium ${l.direction === 'OUT' ? 'text-red-700' : 'text-emerald-700'}`}>{l.direction === 'OUT' ? '−' : '+'}{fmtQty(l.quantity)}</span>
              </li>
            ))}
          </ul>
        )}
        {rejecting && <Field label="Reason for rejecting" required><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus /></Field>}
      </div>
    </Modal>
  )
}
