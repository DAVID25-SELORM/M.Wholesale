import { useQuery } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Badge, Button, EmptyState, ErrorState, Field, InlineError, LoadingState, Modal, Textarea } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { StockStatusBadge } from '@/modules/inventory/shared'
import { fmtQty } from '@/services/inventory'
import { PO_STATUS_LABEL, PO_STATUS_TONE, listReceiptLines, type GoodsReceipt, type PoStatus } from '@/services/purchasing'

export function PoStatusBadge({ status }: { status: string }) {
  const s = status as PoStatus
  return <Badge tone={PO_STATUS_TONE[s] ?? 'slate'}>{PO_STATUS_LABEL[s] ?? status}</Badge>
}

/** Asks for the reason that cancel / send back / close require (it is recorded in the audit log). */
export function ReasonDialog({ open, title, description, confirmLabel, tone, onConfirm, onClose, busy, error }: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  tone?: 'danger' | 'primary'
  onConfirm: (reason: string) => void
  onClose: () => void
  busy: boolean
  error: string | null
}) {
  return open ? <ReasonInner title={title} description={description} confirmLabel={confirmLabel} tone={tone} onConfirm={onConfirm} onClose={onClose} busy={busy} error={error} /> : null
}

function ReasonInner({ title, description, confirmLabel, tone, onConfirm, onClose, busy, error }: Omit<Parameters<typeof ReasonDialog>[0], 'open'>) {
  const [reason, setReason] = useState('')
  const [local, setLocal] = useState<string | null>(null)
  function submit(e: FormEvent) {
    e.preventDefault()
    if (!reason.trim()) { setLocal('Give a short reason - it is recorded in the audit log.'); return }
    setLocal(null)
    onConfirm(reason.trim())
  }
  return (
    <Modal
      open size="sm" title={title} description={description} onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Back</Button>
          <Button type="submit" form="reason-form" variant={tone === 'danger' ? 'danger' : 'primary'} loading={busy}>{confirmLabel}</Button>
        </>
      }
    >
      <form id="reason-form" onSubmit={submit} noValidate className="space-y-3">
        <InlineError message={local ?? error} />
        <Field label="Reason" required><Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </form>
    </Modal>
  )
}

/** The lines of one goods receipt: what arrived, in which batch, in which condition. */
export function GoodsReceiptDialog({ receipt, onClose }: { receipt: GoodsReceipt | null; onClose: () => void }) {
  const lines = useQuery({ queryKey: ['goods-receipt-lines', receipt?.id], queryFn: () => listReceiptLines(receipt!.id), enabled: Boolean(receipt) })
  if (!receipt) return null
  return (
    <Modal
      open size="lg" onClose={onClose}
      title={`${receipt.grn_number}${receipt.purchase_order ? ` · ${receipt.purchase_order.po_number}` : ''}`}
      description={`${receipt.supplier?.name ?? ''} · ${receipt.warehouse?.name ?? ''} · ${formatDateTime(receipt.received_at)}${receipt.delivery_note ? ` · delivery note ${receipt.delivery_note}` : ''}`}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      {receipt.notes && <p className="mb-3 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">{receipt.notes}</p>}
      {lines.isPending ? <LoadingState /> : lines.isError ? <ErrorState message={toAppError(lines.error).message} onRetry={() => void lines.refetch()} /> : (lines.data ?? []).length === 0 ? (
        <EmptyState title="No lines visible" />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <caption className="sr-only">Received lines</caption>
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr><th className="py-2 pr-3">Product</th><th className="pr-3">Batch</th><th className="pr-3">Condition</th><th className="pr-3 text-right">Received</th><th className="text-right">Base units</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(lines.data ?? []).map((l) => (
                <tr key={l.id}>
                  <td className="py-2 pr-3"><span className="font-medium">{l.product?.brand_name}</span> <span className="font-mono text-xs text-slate-500">{l.product?.sku}</span></td>
                  <td className="pr-3 font-mono text-xs">{l.batch ? `${l.batch.batch_number} · ${l.batch.expiry_date}` : '—'}</td>
                  <td className="pr-3"><StockStatusBadge status={l.stock_status as 'AVAILABLE' | 'QUARANTINE' | 'DAMAGED'} /></td>
                  <td className="pr-3 text-right tabular-nums">{fmtQty(Number(l.quantity_received))} {l.unit?.unit?.name?.toLowerCase()}</td>
                  <td className="text-right tabular-nums text-slate-500">{fmtQty(Number(l.received_base))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}
