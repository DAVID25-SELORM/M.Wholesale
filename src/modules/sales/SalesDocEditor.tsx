import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button, Card, CardBody, ErrorState, Field, InlineError, Input, LoadingState, PageHeader, Select, Textarea, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { ReasonDialog } from '@/modules/purchasing/shared'
import { useSession } from '@/modules/session/SessionProvider'
import { getProduct, listProductUnits, type ProductRow } from '@/services/catalog'
import { listCustomerOptions } from '@/services/customers'
import {
  cancelQuotation, cancelSalesOrder, confirmSalesOrder, saveQuotation, saveSalesOrder, sendQuotation, type DocLine, type Quotation, type SalesOrder,
} from '@/services/orders'
import { listTaxCodes, resolvePrice } from '@/services/pricing'
import { moneyFmt } from '@/services/sales'
import { listWarehouseOptions } from '@/services/warehouses'
import { buildSalesLines, emptySalesLine, type SalesLineDraft } from './invoiceLines'
import { LineRow } from './InvoiceEditor'

export type DocKind = 'quotation' | 'order'

let seq = 0
const nextKey = () => `d${++seq}`
const iso = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

const asProduct = (l: DocLine): ProductRow => ({
  id: l.product_id, sku: l.product?.sku ?? '', brand_name: l.product?.brand_name ?? '', generic_name: null, strength_text: null, dosage_form: null,
  manufacturer_name: null, product_class: l.product?.product_class ?? '', is_active: true,
})

/** One editor for the drafts of both documents: a quotation (offer, valid until a date) and a sales order (what the customer ordered). */
export function SalesDocEditor({ kind, doc, lines, presetCustomerId }: { kind: DocKind; doc: Quotation | SalesOrder | null; lines: DocLine[] | null; presetCustomerId: string }) {
  const { ability, selectedBranch } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const isQuote = kind === 'quotation'
  const base = isQuote ? '/sales/quotations' : '/sales/orders'
  const createPerm = isQuote ? 'quotations.create' : 'orders.create'
  const customers = useQuery({ queryKey: ['customer-options'], queryFn: listCustomerOptions, staleTime: 60_000 })
  const warehouses = useQuery({ queryKey: ['warehouse-options', null], queryFn: () => listWarehouseOptions(null), staleTime: 60_000 })
  const taxCodes = useQuery({ queryKey: ['tax-codes'], queryFn: listTaxCodes, staleTime: 60_000 })

  const mine = (warehouses.data ?? []).filter((w) => (w.is_active || w.id === doc?.warehouse_id) && ability.can(createPerm, w.branch_id))
  const preferred = mine.find((w) => w.branch_id === selectedBranch) ?? mine[0]
  const q = doc as Quotation | null
  const o = doc as SalesOrder | null

  const [customerId, setCustomerId] = useState(doc?.customer_id ?? presetCustomerId)
  const [warehouseId, setWarehouseId] = useState(doc?.warehouse_id ?? '')
  const [reference, setReference] = useState(doc?.customer_reference ?? '')
  const [notes, setNotes] = useState(doc?.notes ?? '')
  const [validUntil, setValidUntil] = useState(q?.valid_until ?? iso(30))
  const [requiredDate, setRequiredDate] = useState(o?.required_date ?? '')
  const [reservedUntil, setReservedUntil] = useState(o?.reserved_until ?? '')
  const [rows, setRows] = useState<SalesLineDraft[]>(() =>
    lines && lines.length > 0
      ? lines.map((l) => ({
          key: nextKey(), product: asProduct(l), unitId: Number(l.unit?.factor_to_base ?? 1) === 1 ? '' : l.product_unit_id, factor: Number(l.unit?.factor_to_base ?? 1),
          quantity: String(Number(l.quantity)), listPrice: l.list_price === null ? null : Number(l.list_price),
          price: l.list_price !== null && Number(l.list_price) === Number(l.unit_price) ? '' : String(Number(l.unit_price)),
          discount: Number(l.discount_percent) > 0 ? String(Number(l.discount_percent)) : '', taxRate: Number(l.tax_rate),
        }))
      : [emptySalesLine(nextKey())])
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  const effectiveWarehouse = warehouseId || (doc ? '' : preferred?.id ?? '')
  const branchId = mine.find((w) => w.id === effectiveWarehouse)?.branch_id ?? doc?.branch_id ?? ''
  const rights = { canOverridePrice: ability.can('sales.price_override', branchId), canDiscount: ability.can('sales.discount', branchId) }
  const built = buildSalesLines(rows, rights)
  const patch = (key: string, p: Partial<SalesLineDraft>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))
  const defaultTax = (taxCodes.data ?? []).find((t) => t.is_default)
  const taxRateFor = (id: string | null) => Number((taxCodes.data ?? []).find((t) => t.id === id)?.rate ?? defaultTax?.rate ?? 0)
  const refresh = () => Promise.all(['quotations', 'quotation', 'quotation-lines', 'sales-orders', 'sales-order', 'sales-order-lines', 'order-progress', 'dashboard'].map((k) => qc.invalidateQueries({ queryKey: [k] })))

  async function priceFor(cust: string, productId: string, unitId: string): Promise<number | null> {
    if (!cust) return null
    const unitRowId = unitId || (await qc.fetchQuery({ queryKey: ['product-units', productId], queryFn: () => listProductUnits(productId), staleTime: 60_000 })).find((u) => u.is_base)?.id
    return unitRowId ? resolvePrice(cust, unitRowId) : null
  }
  async function pickProduct(key: string, p: ProductRow | null) {
    if (!p) { patch(key, { product: null, unitId: '', factor: 1, listPrice: null, price: '', taxRate: 0 }); return }
    patch(key, { product: p, unitId: '', factor: 1, listPrice: null, price: '' })
    const [detail, price] = await Promise.all([qc.fetchQuery({ queryKey: ['product', p.id], queryFn: () => getProduct(p.id), staleTime: 60_000 }), priceFor(customerId, p.id, '')])
    patch(key, { product: p, listPrice: price, taxRate: taxRateFor(detail?.tax_code_id ?? null) })
  }
  async function changeUnit(row: SalesLineDraft, unitId: string, factor: number) {
    patch(row.key, { unitId, factor, listPrice: null, price: '' })
    if (row.product) patch(row.key, { listPrice: await priceFor(customerId, row.product.id, unitId) })
  }
  async function changeCustomer(id: string) {
    setCustomerId(id)
    const snapshot = rows
    const prices = await Promise.all(snapshot.map((r) => (r.product ? priceFor(id, r.product.id, r.unitId) : Promise.resolve(null))))
    setRows((rs) => rs.map((r) => { const i = snapshot.findIndex((s) => s.key === r.key); return i >= 0 && r.product ? { ...r, listPrice: prices[i] ?? null } : r }))
  }

  const save = useMutation({
    mutationFn: (saveLines: Extract<typeof built, { ok: true }>['lines']) =>
      isQuote
        ? saveQuotation({ id: doc?.id ?? null, customerId, warehouseId: effectiveWarehouse, validUntil, customerReference: reference, notes, lines: saveLines })
        : saveSalesOrder({ id: doc?.id ?? null, customerId, warehouseId: effectiveWarehouse, requiredDate, reservedUntil, customerReference: reference, notes, lines: saveLines }),
    onError: (e) => setError(toAppError(e).message),
  })
  const cancel = useMutation({
    mutationFn: (reason: string) => (isQuote ? cancelQuotation(doc!.id, reason) : cancelSalesOrder(doc!.id, reason)),
    onSuccess: async () => { toast.success('Draft cancelled.'); await refresh(); navigate(base) },
    onError: (e) => setCancelError(toAppError(e).message),
  })

  async function saveDraft(e?: FormEvent, then?: 'go'): Promise<void> {
    e?.preventDefault()
    if (!customerId) { setError('Choose the customer.'); return }
    if (!effectiveWarehouse) { setError(isQuote ? 'Choose the warehouse the goods would ship from.' : 'Choose the warehouse the stock comes from.'); return }
    if (!built.ok) { setError(built.error); return }
    setError(null)
    let id: string
    try { id = await save.mutateAsync(built.lines) } catch { return }
    if (then === 'go') {
      try {
        if (isQuote) { const no = await sendQuotation(id); toast.success(`${no} sent.`) } else { const no = await confirmSalesOrder(id); toast.success(`${no} confirmed: the stock is reserved.`) }
      } catch (err) {
        setError(toAppError(err).message)
        await refresh()
        if (!doc) navigate(`${base}/${id}`, { replace: true })
        return
      }
    } else if (doc) toast.success('Draft saved.')
    await refresh()
    if (!doc || then === 'go') navigate(`${base}/${id}`, { replace: true })
  }

  if (customers.isPending || warehouses.isPending) return <LoadingState />
  if (customers.isError) return <ErrorState message={toAppError(customers.error).message} onRetry={() => void customers.refetch()} />

  const goPerm = isQuote ? createPerm : 'orders.confirm'
  return (
    <>
      <PageHeader
        title={doc ? (isQuote ? 'Draft quotation' : 'Draft order') : isQuote ? 'New quotation' : 'New sales order'}
        description={isQuote
          ? 'An offer at stated prices, valid until a date. No stock is held for a quotation.'
          : 'What the customer ordered. Confirming the order reserves the stock for them until it is delivered, closed or cancelled.'}
        actions={doc && <Button variant="ghost" onClick={() => { setCancelError(null); setCancelling(true) }}>Cancel draft</Button>}
      />
      <form onSubmit={(e) => void saveDraft(e)} noValidate className="space-y-5">
        <InlineError message={error} />
        <Card>
          <CardBody className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Customer" required>
                <Select value={customerId} onChange={(e) => void changeCustomer(e.target.value)}>
                  <option value="">Select…</option>
                  {(customers.data ?? []).filter((c) => (c.is_active || c.id === customerId) && (isQuote || c.code !== 'WALKIN')).map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code}){c.on_hold ? ' - ON HOLD' : ''}</option>)}
                </Select>
              </Field>
              <Field label={isQuote ? 'Ships from' : 'Stock from'} required>
                <Select value={effectiveWarehouse} onChange={(e) => setWarehouseId(e.target.value)}>
                  <option value="">Select…</option>
                  {mine.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </Select>
              </Field>
              <Field label={isQuote ? 'Customer’s enquiry reference' : 'Customer’s purchase order no.'}><Input value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} /></Field>
            </div>
            {isQuote ? (
              <Field label="Valid until" required hint="After this date the quotation can no longer be accepted."><Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} className="sm:w-56" /></Field>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Needed by"><Input type="date" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} /></Field>
                <Field label="Hold the stock until" hint="Optional. The reservation lapses after this date; empty = until the order ends."><Input type="date" value={reservedUntil} onChange={(e) => setReservedUntil(e.target.value)} /></Field>
              </div>
            )}
          </CardBody>
        </Card>

        <div className="space-y-3">
          {rows.map((r, i) => (
            <LineRow
              key={r.key} index={i} row={r} warehouseId={effectiveWarehouse} rights={rights}
              onPick={(p) => void pickProduct(r.key, p)} onUnit={(u, f) => void changeUnit(r, u, f)} onChange={(p) => patch(r.key, p)}
              onRemove={rows.length > 1 ? () => setRows((rs) => rs.filter((x) => x.key !== r.key)) : null}
            />
          ))}
          <Button type="button" variant="secondary" size="sm" onClick={() => setRows((rs) => [...rs, emptySalesLine(nextKey())])} disabled={rows.length >= 200}><Plus className="h-4 w-4" aria-hidden /> Add line</Button>
        </div>

        <Card>
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label={isQuote ? 'Terms and notes' : 'Notes'} hint={isQuote ? 'Shown on the quotation.' : undefined}><Textarea rows={3} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            <dl className="ml-auto w-full max-w-xs space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">Subtotal</dt><dd className="tabular-nums">{built.ok ? moneyFmt(built.subtotal) : '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Tax</dt><dd className="tabular-nums">{built.ok ? moneyFmt(built.tax) : '—'}</dd></div>
              <div className="flex justify-between border-t border-slate-200 pt-1 text-base font-semibold"><dt>Total</dt><dd className="tabular-nums">{built.ok ? moneyFmt(built.total) : '—'}</dd></div>
            </dl>
          </CardBody>
        </Card>

        <div className="flex flex-wrap justify-end gap-2">
          <Link to={base}><Button type="button" variant="ghost">Back</Button></Link>
          <Button type="submit" variant="secondary" loading={save.isPending}>Save draft</Button>
          {ability.can(goPerm, branchId) && <Button type="button" onClick={() => void saveDraft(undefined, 'go')} loading={save.isPending}>{isQuote ? 'Save and send' : 'Save and confirm'}</Button>}
        </div>
      </form>
      {cancelling && (
        <ReasonDialog
          open title="Cancel this draft" description="The draft is discarded." confirmLabel="Cancel draft" tone="danger"
          busy={cancel.isPending} error={cancelError} onConfirm={(r) => cancel.mutate(r)} onClose={() => setCancelling(false)}
        />
      )}
    </>
  )
}
