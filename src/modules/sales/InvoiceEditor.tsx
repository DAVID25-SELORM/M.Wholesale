import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Badge, Button, Card, CardBody, ErrorState, Field, InlineError, Input, LoadingState, PageHeader, Select, Textarea, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { ProductPicker } from '@/modules/catalog/ProductPicker'
import { ReasonDialog } from '@/modules/purchasing/shared'
import { useSession } from '@/modules/session/SessionProvider'
import { getProduct, listProductUnits, type ProductRow } from '@/services/catalog'
import { CUSTOMER_TYPE_LABEL, MEDICINE_BUYERS, getCustomerCredit, licenceDaysLeft, listCustomerOptions, type CustomerOption, type CustomerType } from '@/services/customers'
import { fmtQty, listProductBalances } from '@/services/inventory'
import { listTaxCodes, resolvePrice } from '@/services/pricing'
import { cancelSalesInvoice, computeLine, moneyFmt, saveSalesInvoice, type SalesInvoice, type SalesInvoiceLine } from '@/services/sales'
import { listWarehouseOptions } from '@/services/warehouses'
import { buildSalesLines, effectivePrice, emptySalesLine, type SalesLineDraft } from './invoiceLines'

let seq = 0
const nextKey = () => `s${++seq}`
const today = () => new Date().toISOString().slice(0, 10)

const asProduct = (l: SalesInvoiceLine): ProductRow => ({
  id: l.product_id, sku: l.product?.sku ?? '', brand_name: l.product?.brand_name ?? '', generic_name: null, strength_text: null, dosage_form: null,
  manufacturer_name: null, product_class: l.product?.product_class ?? '', is_active: true,
})

export function InvoiceEditor({ invoice, lines, presetCustomerId }: { invoice: SalesInvoice | null; lines: SalesInvoiceLine[] | null; presetCustomerId: string }) {
  const { ability, branches, selectedBranch } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const customers = useQuery({ queryKey: ['customer-options'], queryFn: listCustomerOptions, staleTime: 60_000 })
  const warehouses = useQuery({ queryKey: ['warehouse-options', null], queryFn: () => listWarehouseOptions(null), staleTime: 60_000 })
  const taxCodes = useQuery({ queryKey: ['tax-codes'], queryFn: listTaxCodes, staleTime: 60_000 })

  const sellFrom = (warehouses.data ?? []).filter((w) => (w.is_active || w.id === invoice?.warehouse_id) && ability.can('sales.create', w.branch_id))
  const preferred = sellFrom.find((w) => w.branch_id === selectedBranch) ?? sellFrom[0]

  const [customerId, setCustomerId] = useState(invoice?.customer_id ?? presetCustomerId)
  const [warehouseId, setWarehouseId] = useState(invoice?.warehouse_id ?? '')
  const [reference, setReference] = useState(invoice?.customer_reference ?? '')
  const [notes, setNotes] = useState(invoice?.notes ?? '')
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
  const [posting, setPosting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  const effectiveWarehouse = warehouseId || (invoice ? '' : preferred?.id ?? '')
  const warehouse = (warehouses.data ?? []).find((w) => w.id === effectiveWarehouse)
  const branchId = warehouse?.branch_id ?? invoice?.branch_id ?? branches[0]?.id ?? ''
  const rights = { canOverridePrice: ability.can('sales.price_override', branchId), canDiscount: ability.can('sales.discount', branchId) }
  const customer = (customers.data ?? []).find((c) => c.id === customerId)
  const credit = useQuery({ queryKey: ['customer-credit', customerId], queryFn: () => getCustomerCredit(customerId), enabled: Boolean(customerId) && ability.canAnywhere('receipts.view') })
  const built = buildSalesLines(rows, rights)
  const patch = (key: string, p: Partial<SalesLineDraft>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))

  const defaultTax = (taxCodes.data ?? []).find((t) => t.is_default)
  const taxRateFor = (taxCodeId: string | null) => Number((taxCodes.data ?? []).find((t) => t.id === taxCodeId)?.rate ?? defaultTax?.rate ?? 0)

  /** Looks up the price list price of a product pack level for a customer. */
  async function priceFor(cust: string, productId: string, unitId: string): Promise<number | null> {
    if (!cust) return null
    const unitRowId = unitId || (await qc.fetchQuery({ queryKey: ['product-units', productId], queryFn: () => listProductUnits(productId), staleTime: 60_000 })).find((u) => u.is_base)?.id
    return unitRowId ? resolvePrice(cust, unitRowId) : null
  }

  async function pickProduct(key: string, p: ProductRow | null) {
    if (!p) { patch(key, { product: null, unitId: '', factor: 1, listPrice: null, price: '', taxRate: 0 }); return }
    patch(key, { product: p, unitId: '', factor: 1, listPrice: null, price: '' })
    const [detail, price] = await Promise.all([
      qc.fetchQuery({ queryKey: ['product', p.id], queryFn: () => getProduct(p.id), staleTime: 60_000 }),
      priceFor(customerId, p.id, ''),
    ])
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
      saveSalesInvoice({ id: invoice?.id ?? null, customerId, warehouseId: effectiveWarehouse, customerReference: reference, notes, lines: saveLines }),
    onError: (e) => setError(toAppError(e).message),
  })
  const cancel = useMutation({
    mutationFn: (reason: string) => cancelSalesInvoice(invoice!.id, reason),
    onSuccess: async () => { toast.success('Draft cancelled.'); await refresh(); navigate('/sales/invoices') },
    onError: (e) => setCancelError(toAppError(e).message),
  })
  const refresh = () => Promise.all(['sales-invoices', 'sales-invoice', 'sales-invoice-lines', 'dashboard'].map((k) => qc.invalidateQueries({ queryKey: [k] })))

  function validate(): Extract<typeof built, { ok: true }> | null {
    if (!customerId) { setError('Choose the customer.'); return null }
    if (!effectiveWarehouse) { setError('Choose the warehouse the goods are dispatched from.'); return null }
    if (!built.ok) { setError(built.error); return null }
    setError(null)
    return built
  }

  async function saveDraft(e?: FormEvent): Promise<string | null> {
    e?.preventDefault()
    const ok = validate()
    if (!ok) return null
    try {
      const id = await save.mutateAsync(ok.lines)
      await refresh()
      if (!invoice) navigate(`/sales/invoices/${id}`, { replace: true })
      else toast.success('Draft saved.')
      return id
    } catch {
      return null
    }
  }

  async function startPosting() {
    setPosting(true)
    const id = await saveDraft()
    setPosting(false)
    if (id) navigate(`/sales/invoices/${id}?post=1`, { replace: true })
  }

  if (customers.isPending || warehouses.isPending) return <LoadingState />
  if (customers.isError) return <ErrorState message={toAppError(customers.error).message} onRetry={() => void customers.refetch()} />

  const days = customer ? licenceDaysLeft(customer.licence_expiry) : null
  const warnings: string[] = []
  if (customer?.on_hold) warnings.push(`On credit hold: ${customer.hold_reason ?? ''}`)
  if (customer && rows.some((r) => r.product && ['POM', 'P', 'CONTROLLED'].includes(r.product.product_class))) {
    if (!MEDICINE_BUYERS.includes(customer.customer_type as CustomerType)) warnings.push(`${CUSTOMER_TYPE_LABEL[customer.customer_type as CustomerType]} customers cannot buy prescription-only, pharmacy-only or controlled medicines.`)
    else if (days === null) warnings.push('The customer’s premises licence is not recorded: medicines cannot be sold until it is.')
    else if (days < 0) warnings.push(`The customer’s premises licence expired on ${customer.licence_expiry}: medicines cannot be sold until it is renewed.`)
  }
  const totalNow = built.ok ? built.total : 0

  return (
    <>
      <PageHeader
        title={invoice ? 'Draft invoice' : 'New sales invoice'}
        description="Prices come from the customer’s price list; stock is picked earliest-expiry-first when the invoice is posted."
        actions={invoice && (
          <Button variant="ghost" onClick={() => { setCancelError(null); setCancelling(true) }}>Cancel draft</Button>
        )}
      />
      <form onSubmit={(e) => void saveDraft(e)} noValidate className="space-y-5">
        <InlineError message={error} />
        <Card>
          <CardBody className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Customer" required>
                <Select value={customerId} onChange={(e) => void changeCustomer(e.target.value)}>
                  <option value="">Select…</option>
                  {(customers.data ?? []).filter((c) => c.is_active || c.id === customerId).map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code}){c.on_hold ? ' - ON HOLD' : ''}</option>)}
                </Select>
              </Field>
              <Field label="Dispatch from" required>
                <Select value={effectiveWarehouse} onChange={(e) => setWarehouseId(e.target.value)}>
                  <option value="">Select…</option>
                  {sellFrom.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </Select>
              </Field>
              <Field label="Customer’s order reference"><Input value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} /></Field>
            </div>
            {customer && <CustomerStrip customer={customer} credit={credit.data} total={totalNow} />}
            {warnings.map((w) => (
              <p key={w} role="alert" className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{w}</p>
            ))}
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
            <Field label="Notes" hint="Shown on the invoice."><Textarea rows={3} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            <dl className="ml-auto w-full max-w-xs space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">Subtotal</dt><dd className="tabular-nums">{built.ok ? moneyFmt(built.subtotal) : '—'}</dd></div>
              {built.ok && built.discount > 0 && <div className="flex justify-between"><dt className="text-slate-500">Discounts given</dt><dd className="tabular-nums text-slate-500">{moneyFmt(built.discount)}</dd></div>}
              <div className="flex justify-between"><dt className="text-slate-500">Tax</dt><dd className="tabular-nums">{built.ok ? moneyFmt(built.tax) : '—'}</dd></div>
              <div className="flex justify-between border-t border-slate-200 pt-1 text-base font-semibold"><dt>Total</dt><dd className="tabular-nums">{built.ok ? moneyFmt(built.total) : '—'}</dd></div>
            </dl>
          </CardBody>
        </Card>

        <div className="flex flex-wrap justify-end gap-2">
          <Link to="/sales/invoices"><Button type="button" variant="ghost">Back</Button></Link>
          <Button type="submit" variant="secondary" loading={save.isPending && !posting}>Save draft</Button>
          {ability.can('sales.post', branchId) && <Button type="button" onClick={() => void startPosting()} loading={save.isPending && posting}>Save and post…</Button>}
        </div>
      </form>

      {cancelling && (
        <ReasonDialog
          open title="Cancel this draft" description="The draft is discarded. Nothing was posted, so stock and the customer's account are unaffected." confirmLabel="Cancel draft" tone="danger"
          busy={cancel.isPending} error={cancelError} onConfirm={(reason) => cancel.mutate(reason)} onClose={() => setCancelling(false)}
        />
      )}
    </>
  )
}

function CustomerStrip({ customer, credit, total }: { customer: CustomerOption; credit: Awaited<ReturnType<typeof getCustomerCredit>> | undefined; total: number }) {
  const days = licenceDaysLeft(customer.licence_expiry)
  const limit = Number(customer.credit_limit)
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">
      <span>{CUSTOMER_TYPE_LABEL[customer.customer_type as CustomerType]}</span>
      <span>Terms {customer.payment_terms_days} days</span>
      <span>{limit > 0 ? `Credit limit ${moneyFmt(limit)}` : 'Cash only (no credit)'}</span>
      {credit && <span>Owes <strong className="text-slate-900">{moneyFmt(credit.outstanding)}</strong>{credit.credit_held > 0 ? <span> · credit {moneyFmt(credit.credit_held)}</span> : null}</span>}
      {credit && limit > 0 && total > 0 && credit.outstanding + total - credit.credit_held > limit && <Badge tone="red">This invoice goes over the limit</Badge>}
      {days !== null && days < 0 && <Badge tone="red">Licence expired</Badge>}
      {days !== null && days >= 0 && days <= 60 && <Badge tone="amber">Licence expires in {days} d</Badge>}
    </div>
  )
}

export function LineRow({ index, row, warehouseId, rights, onPick, onUnit, onChange, onRemove }: {
  index: number
  row: SalesLineDraft
  warehouseId: string
  rights: { canOverridePrice: boolean; canDiscount: boolean }
  onPick: (p: ProductRow | null) => void
  onUnit: (unitId: string, factor: number) => void
  onChange: (p: Partial<SalesLineDraft>) => void
  onRemove: (() => void) | null
}) {
  const pid = row.product?.id
  const units = useQuery({ queryKey: ['product-units', pid], queryFn: () => listProductUnits(pid!), enabled: Boolean(pid), staleTime: 60_000 })
  const balances = useQuery({ queryKey: ['balances', pid, warehouseId], queryFn: () => listProductBalances(pid!, warehouseId), enabled: Boolean(pid && warehouseId) })
  const usable = (units.data ?? []).filter((u) => u.is_active && u.is_sellable)
  const baseName = usable.find((u) => u.is_base)?.unit?.name ?? 'base unit'
  const available = (balances.data ?? []).filter((b) => b.stock_status === 'AVAILABLE' && (!b.batch || b.batch.expiry_date >= today())).reduce((s, b) => s + b.quantity, 0)
  const qty = Number(row.quantity)
  const need = Number.isFinite(qty) ? qty * row.factor : 0
  const price = effectivePrice(row)
  const calc = price !== null && Number.isFinite(qty) && qty > 0 ? computeLine(qty, price, Number(row.discount) || 0, row.taxRate) : null

  return (
    <fieldset className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/50 p-3">
      <legend className="flex w-full items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <span>Line {index + 1}</span>
        {onRemove && <button type="button" onClick={onRemove} className="inline-flex items-center gap-1 text-slate-500 hover:text-red-600" aria-label={`Remove line ${index + 1}`}><Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove</button>}
      </legend>
      <ProductPicker value={row.product} onChange={onPick} />
      {row.product && (
        <div className="grid gap-3 sm:grid-cols-12">
          <Field label="Pack" className="sm:col-span-2">
            <Select value={row.unitId} onChange={(e) => onUnit(e.target.value, Number(usable.find((u) => u.id === e.target.value)?.factor_to_base ?? 1))}>
              <option value="">{baseName}</option>
              {usable.filter((u) => !u.is_base).map((u) => <option key={u.id} value={u.id}>{u.unit?.name} (×{Number(u.factor_to_base)})</option>)}
            </Select>
          </Field>
          <Field label="Quantity" required className="sm:col-span-2" hint={warehouseId && balances.isSuccess ? `${fmtQty(available)} ${baseName.toLowerCase()} sellable` : undefined}>
            <Input type="number" inputMode="decimal" min="0" step="any" value={row.quantity} onChange={(e) => onChange({ quantity: e.target.value })} aria-invalid={need > available && balances.isSuccess ? true : undefined} />
          </Field>
          <Field label="Price" className="sm:col-span-2" hint={row.listPrice === null ? 'No list price' : row.price.trim() !== '' && Number(row.price) !== row.listPrice ? `List ${moneyFmt(row.listPrice)}` : 'List price'}>
            <Input type="number" inputMode="decimal" min="0" step="any" placeholder={row.listPrice === null ? '' : String(row.listPrice)} value={row.price}
              onChange={(e) => onChange({ price: e.target.value })} disabled={!rights.canOverridePrice && row.listPrice !== null} />
          </Field>
          <Field label="Discount %" className="sm:col-span-2">
            <Input type="number" inputMode="decimal" min="0" max="100" step="0.01" value={row.discount} onChange={(e) => onChange({ discount: e.target.value })} disabled={!rights.canDiscount} />
          </Field>
          <div className="flex flex-col justify-end pb-2 text-right text-sm sm:col-span-4">
            {calc ? (
              <>
                <span className="font-semibold tabular-nums text-slate-900">{moneyFmt(calc.total)}</span>
                <span className="text-xs text-slate-500">{moneyFmt(calc.net)}{row.taxRate > 0 ? ` + ${row.taxRate}% tax ${moneyFmt(calc.tax)}` : ' · tax exempt'}</span>
              </>
            ) : <span className="text-slate-400">—</span>}
          </div>
        </div>
      )}
      {row.product && need > available && balances.isSuccess && warehouseId && (
        <p className="text-xs text-red-700">Only {fmtQty(available)} {baseName.toLowerCase()} are sellable here (unexpired and available). Posting will be refused unless stock arrives first.</p>
      )}
    </fieldset>
  )
}
