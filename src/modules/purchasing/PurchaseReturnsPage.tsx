import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import {
  Badge, Button, Card, DataTable, EmptyState, ErrorState, Field, InlineError, Input, LoadingState, Modal, PageHeader, Pagination, SearchInput,
  Select, Textarea, useToast, type Column,
} from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { ProductPicker } from '@/modules/catalog/ProductPicker'
import { StockStatusBadge } from '@/modules/inventory/shared'
import { useSession } from '@/modules/session/SessionProvider'
import { listProductUnits, type ProductRow } from '@/services/catalog'
import { fmtQty, listProductBalances, type BalanceRow, type StockStatus } from '@/services/inventory'
import {
  RETURN_REASONS, RETURN_REASON_LABEL, listPurchaseReturns, listReturnLines, postPurchaseReturn, recordReturnCredit,
  type PurchaseReturn, type ReturnReason,
} from '@/services/purchasing'
import { listSupplierOptions } from '@/services/suppliers'
import { listWarehouseOptions } from '@/services/warehouses'

const PAGE_SIZE = 20

export function PurchaseReturnsPage() {
  const { ability } = useSession()
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [credit, setCredit] = useState<'PENDING' | 'CREDITED' | ''>('')
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<PurchaseReturn | null>(null)
  const params = { page, pageSize: PAGE_SIZE, search, credit }
  const query = useQuery({ queryKey: ['purchase-returns', params], queryFn: () => listPurchaseReturns(params), placeholderData: (prev) => prev })

  const columns: Column<PurchaseReturn>[] = [
    { key: 'no', header: 'Return', render: (r) => <button type="button" className="font-mono text-xs font-semibold text-brand-700 hover:underline" onClick={() => setOpen(r)}>{r.return_number}</button> },
    { key: 'supplier', header: 'Supplier', render: (r) => r.supplier?.name ?? '—' },
    { key: 'reason', header: 'Reason', hideOnMobile: true, render: (r) => RETURN_REASON_LABEL[r.reason as ReturnReason] ?? r.reason },
    { key: 'credit', header: 'Credit', render: (r) => (r.credit_status === 'CREDITED' ? <Badge tone="green">Credited {Number(r.credit_amount).toFixed(2)}</Badge> : <Badge tone="amber">Awaiting credit note</Badge>) },
    { key: 'exp', header: 'Expected', hideOnMobile: true, className: 'text-right', render: (r) => <span className="tabular-nums">{Number(r.expected_credit).toFixed(2)}</span> },
    { key: 'when', header: 'Returned', render: (r) => <span className="whitespace-nowrap text-slate-600">{formatDateTime(r.returned_at)}</span> },
  ]

  return (
    <>
      <PageHeader
        title="Purchase returns"
        description="Goods sent back to a supplier. Posting takes them out of stock immediately; record the supplier's credit note when it arrives."
        actions={ability.canAnywhere('purchasing.receive') && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> New return</Button>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row">
          <div className="flex-1"><SearchInput value={search} onChange={(v) => { setSearch(v); setPage(0) }} placeholder="Search by return or credit note number" label="Search returns" /></div>
          <div className="w-full sm:w-56">
            <label htmlFor="ret-credit" className="sr-only">Credit</label>
            <Select id="ret-credit" value={credit} onChange={(e) => { setCredit(e.target.value as typeof credit); setPage(0) }}>
              <option value="">All returns</option>
              <option value="PENDING">Awaiting credit note</option>
              <option value="CREDITED">Credited</option>
            </Select>
          </div>
        </div>
        <DataTable
          caption="Purchase returns"
          columns={columns}
          rows={query.data?.rows}
          rowKey={(r) => r.id}
          loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null}
          onRetry={() => void query.refetch()}
          emptyTitle="No purchase returns"
          emptyDescription="Use “New return” when damaged, expired or wrong goods go back to a supplier."
        />
        <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>
      <NewReturnDialog open={creating} onClose={() => setCreating(false)} />
      <ReturnDialog ret={open} canCredit={open ? ability.can('payables.create', open.branch_id) : false} onClose={() => setOpen(null)} />
    </>
  )
}

// ---- new return ------------------------------------------------------------------------------------------------
interface Draft { key: string; product: ProductRow | null; unitId: string; factor: number; quantity: string; balance: BalanceRow | null }
let seq = 0
const nextKey = () => `x${++seq}`
const blank = (): Draft => ({ key: nextKey(), product: null, unitId: '', factor: 1, quantity: '', balance: null })

function NewReturnDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return open ? <NewReturnInner onClose={onClose} /> : null
}

function NewReturnInner({ onClose }: { onClose: () => void }) {
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const suppliers = useQuery({ queryKey: ['supplier-options'], queryFn: listSupplierOptions, staleTime: 60_000 })
  const warehouses = useQuery({ queryKey: ['warehouse-options', null], queryFn: () => listWarehouseOptions(null), staleTime: 60_000 })
  const [supplierId, setSupplierId] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [reason, setReason] = useState<ReturnReason | ''>('')
  const [notes, setNotes] = useState('')
  const [rows, setRows] = useState<Draft[]>(() => [blank()])
  const [error, setError] = useState<string | null>(null)
  const patch = (key: string, p: Partial<Draft>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))
  const mine = (warehouses.data ?? []).filter((w) => w.is_active && ability.can('purchasing.receive', w.branch_id))

  const post = useMutation({
    mutationFn: () =>
      postPurchaseReturn({
        supplierId, warehouseId, reason: reason as ReturnReason, notes,
        lines: rows.map((r) => ({
          product_id: r.product!.id, quantity: Number(r.quantity), ...(r.unitId ? { product_unit_id: r.unitId } : {}),
          ...(r.balance?.batch_id ? { batch_id: r.balance.batch_id } : {}), ...(r.balance?.location_id ? { location_id: r.balance.location_id } : {}),
          status: r.balance!.stock_status,
        })),
      }),
    onSuccess: async (r) => {
      toast.success(`${r.return_number} posted - stock updated.`)
      await Promise.all(['purchase-returns', 'stock', 'balances', 'stock-documents', 'expiring', 'payables'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
      onClose()
    },
    onError: (e) => setError(toAppError(e).message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!supplierId) { setError('Choose the supplier the goods go back to.'); return }
    if (!warehouseId) { setError('Choose the warehouse the goods leave from.'); return }
    if (!reason) { setError('Choose a reason.'); return }
    const taken = new Map<string, number>()
    for (const [i, r] of rows.entries()) {
      const fail = (m: string) => { setError(`Line ${i + 1}: ${m}`) }
      if (!r.product) return fail('choose a product.')
      if (!r.balance) return fail('choose which stock is going back.')
      const qty = Number(r.quantity)
      if (r.quantity.trim() === '' || !Number.isFinite(qty) || qty <= 0) return fail('enter a quantity greater than 0.')
      const base = qty * r.factor
      const used = (taken.get(r.balance.id) ?? 0) + base
      taken.set(r.balance.id, used)
      if (used > r.balance.quantity + 1e-9) return fail(`only ${fmtQty(r.balance.quantity)} is in that stock.`)
    }
    setError(null)
    post.mutate()
  }

  return (
    <Modal
      open size="lg" onClose={onClose} title="New purchase return"
      description="The goods leave stock the moment you post. Pick the exact batch that is going back."
      footer={<><Button variant="secondary" onClick={onClose} disabled={post.isPending}>Cancel</Button><Button type="submit" form="ret-form" loading={post.isPending}>Post return</Button></>}
    >
      <form id="ret-form" onSubmit={submit} noValidate className="space-y-4">
        <InlineError message={error} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Supplier" required>
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Select…</option>
              {(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="From warehouse" required>
            <Select value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setRows((rs) => rs.map((r) => ({ ...r, balance: null }))) }}>
              <option value="">Select…</option>
              {mine.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </Field>
          <Field label="Reason" required>
            <Select value={reason} onChange={(e) => setReason(e.target.value as ReturnReason)}>
              <option value="">Select…</option>
              {RETURN_REASONS.map((r) => <option key={r} value={r}>{RETURN_REASON_LABEL[r]}</option>)}
            </Select>
          </Field>
        </div>
        <div className="space-y-3">
          {rows.map((r, i) => (
            <LineEditor key={r.key} index={i} row={r} warehouseId={warehouseId} onChange={(p) => patch(r.key, p)} onRemove={rows.length > 1 ? () => setRows((x) => x.filter((y) => y.key !== r.key)) : null} />
          ))}
          <Button type="button" variant="secondary" size="sm" onClick={() => setRows((x) => [...x, blank()])} disabled={rows.length >= 200}><Plus className="h-4 w-4" aria-hidden /> Add line</Button>
        </div>
        <Field label="Notes" hint="What was wrong, who was told, any delivery note of the return."><Textarea rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </form>
    </Modal>
  )
}

function LineEditor({ index, row, warehouseId, onChange, onRemove }: { index: number; row: Draft; warehouseId: string; onChange: (p: Partial<Draft>) => void; onRemove: (() => void) | null }) {
  const pid = row.product?.id
  const units = useQuery({ queryKey: ['product-units', pid], queryFn: () => listProductUnits(pid!), enabled: Boolean(pid) })
  const balances = useQuery({ queryKey: ['balances', pid, warehouseId], queryFn: () => listProductBalances(pid!, warehouseId), enabled: Boolean(pid && warehouseId) })
  const usable = (units.data ?? []).filter((u) => u.is_active)
  const base = usable.find((u) => u.is_base)?.unit?.name ?? 'base unit'
  return (
    <fieldset className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/50 p-3">
      <legend className="flex w-full items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <span>Line {index + 1}</span>
        {onRemove && <button type="button" onClick={onRemove} className="inline-flex items-center gap-1 text-slate-500 hover:text-red-600" aria-label={`Remove line ${index + 1}`}><Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove</button>}
      </legend>
      <ProductPicker value={row.product} onChange={(p) => onChange({ product: p, unitId: '', factor: 1, balance: null })} />
      {row.product && (
        <div className="grid gap-3 sm:grid-cols-6">
          <Field label="Quantity" required className="sm:col-span-2"><Input type="number" inputMode="decimal" min="0" step="any" value={row.quantity} onChange={(e) => onChange({ quantity: e.target.value })} /></Field>
          <Field label="In" className="sm:col-span-2" hint={row.factor !== 1 && Number(row.quantity) > 0 ? `= ${fmtQty(Number(row.quantity) * row.factor)} ${base.toLowerCase()}` : undefined}>
            <Select value={row.unitId} onChange={(e) => onChange({ unitId: e.target.value, factor: Number(usable.find((u) => u.id === e.target.value)?.factor_to_base ?? 1) })}>
              <option value="">{base}</option>
              {usable.filter((u) => !u.is_base).map((u) => <option key={u.id} value={u.id}>{u.unit?.name} (×{Number(u.factor_to_base)})</option>)}
            </Select>
          </Field>
          <Field label="Take from" required className="sm:col-span-6">
            <Select value={row.balance?.id ?? ''} disabled={!warehouseId} onChange={(e) => onChange({ balance: balances.data?.find((b) => b.id === e.target.value) ?? null })}>
              <option value="">{!warehouseId ? 'Choose the warehouse first' : balances.isFetching ? 'Loading stock…' : (balances.data ?? []).length === 0 ? 'No stock of this product here' : 'Select batch…'}</option>
              {(balances.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {[b.batch ? `Batch ${b.batch.batch_number} (exp ${b.batch.expiry_date})` : 'No batch', b.stock_status.toLowerCase(), b.location ? `Loc ${b.location.code}` : null, `${fmtQty(b.quantity)} on hand`].filter(Boolean).join(' · ')}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </fieldset>
  )
}

// ---- one return: lines + recording the credit note -----------------------------------------------------------------
function ReturnDialog({ ret, canCredit, onClose }: { ret: PurchaseReturn | null; canCredit: boolean; onClose: () => void }) {
  return ret ? <ReturnInner key={ret.id} ret={ret} canCredit={canCredit} onClose={onClose} /> : null
}

function ReturnInner({ ret, canCredit, onClose }: { ret: PurchaseReturn; canCredit: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const lines = useQuery({ queryKey: ['purchase-return-lines', ret.id], queryFn: () => listReturnLines(ret.id) })
  const [note, setNote] = useState('')
  const [amount, setAmount] = useState(String(Number(ret.expected_credit) || ''))
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: () => recordReturnCredit(ret.id, note.trim(), Number(amount)),
    onSuccess: async () => {
      toast.success('Credit recorded.')
      await Promise.all(['purchase-returns', 'payables'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
      onClose()
    },
    onError: (e) => setError(toAppError(e).message),
  })
  function submit(e: FormEvent) {
    e.preventDefault()
    if (!note.trim()) { setError('Enter the supplier’s credit note number.'); return }
    const n = Number(amount)
    if (amount.trim() === '' || !Number.isFinite(n) || n < 0) { setError('Enter the credit amount (0 or more).'); return }
    setError(null)
    save.mutate()
  }
  return (
    <Modal
      open size="lg" onClose={onClose} title={`${ret.return_number} · ${ret.supplier?.name ?? ''}`}
      description={`${RETURN_REASON_LABEL[ret.reason as ReturnReason] ?? ret.reason} · from ${ret.warehouse?.name ?? ''} · ${formatDateTime(ret.returned_at)}`}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      {ret.notes && <p className="mb-3 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">{ret.notes}</p>}
      {lines.isPending ? <LoadingState /> : lines.isError ? <ErrorState message={toAppError(lines.error).message} onRetry={() => void lines.refetch()} /> : (lines.data ?? []).length === 0 ? <EmptyState title="No lines" /> : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <caption className="sr-only">Returned lines</caption>
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-2 pr-3">Product</th><th className="pr-3">Batch</th><th className="pr-3">Stock was</th><th className="pr-3 text-right">Returned</th><th className="text-right">Cost value</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {(lines.data ?? []).map((l) => (
                <tr key={l.id}>
                  <td className="py-2 pr-3"><span className="font-medium">{l.product?.brand_name}</span> <span className="font-mono text-xs text-slate-500">{l.product?.sku}</span></td>
                  <td className="pr-3 font-mono text-xs">{l.batch ? `${l.batch.batch_number} · ${l.batch.expiry_date}` : '—'}</td>
                  <td className="pr-3"><StockStatusBadge status={l.stock_status as StockStatus} /></td>
                  <td className="pr-3 text-right tabular-nums">{fmtQty(Number(l.quantity_returned))} {l.unit?.unit?.name?.toLowerCase()}</td>
                  <td className="text-right tabular-nums">{l.unit_cost_base === null ? <span className="text-slate-400">no cost</span> : (Number(l.returned_base) * Number(l.unit_cost_base)).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-4 border-t border-slate-100 pt-4">
        {ret.credit_status === 'CREDITED' ? (
          <p className="text-sm text-slate-700">Credit note <strong>{ret.credit_note_number}</strong> for <strong>{Number(ret.credit_amount).toFixed(2)}</strong> recorded {ret.credited_at ? formatDateTime(ret.credited_at) : ''}.</p>
        ) : canCredit ? (
          <form onSubmit={submit} noValidate className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-700">Record the supplier’s credit note</h3>
            <p className="text-xs text-slate-500">Expected credit from batch costs: {Number(ret.expected_credit).toFixed(2)}. Enter what the supplier actually credited.</p>
            <InlineError message={error} />
            <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
              <Field label="Credit note number" required><Input value={note} maxLength={60} onChange={(e) => setNote(e.target.value)} /></Field>
              <Field label="Amount" required><Input type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
              <Button type="submit" loading={save.isPending}>Record credit</Button>
            </div>
          </form>
        ) : (
          <p className="text-sm text-slate-500">Waiting for the supplier’s credit note.</p>
        )}
      </div>
    </Modal>
  )
}
