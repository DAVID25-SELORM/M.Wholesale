import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Minus, Plus, Printer, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, CardBody, CardHeader, ErrorState, Field, InlineError, Input, LoadingState, Modal, PageHeader, Select, Textarea, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { useAuth } from '@/modules/auth/AuthProvider'
import { buildSalesLines, effectivePrice, emptySalesLine, type SalesLineDraft } from '@/modules/sales/invoiceLines'
import { useSession } from '@/modules/session/SessionProvider'
import { getProduct, listProducts, listProductUnits, type ProductRow } from '@/services/catalog'
import { listCustomerOptions } from '@/services/customers'
import { getMyOpenSession, getSessionSummary, getWalkInCustomer, openPosSession, closePosSession, posCheckout, type CheckoutResult, type PosPayment, type PosSession } from '@/services/pos'
import { listTaxCodes, resolvePrice } from '@/services/pricing'
import { RECEIPT_METHOD_LABEL, computeLine, moneyFmt, round2, type ReceiptMethod } from '@/services/sales'
import { listWarehouseOptions } from '@/services/warehouses'
import { PosReceipt } from './PosReceipt'
import { useAppSettings } from '@/modules/settings/useAppSettings'

let seq = 0
const nextKey = () => `p${++seq}`
const POS_METHODS: ReceiptMethod[] = ['CASH', 'MOBILE_MONEY', 'CARD', 'BANK_TRANSFER', 'CHEQUE']

export function PosPage() {
  const { auth } = useAuth()
  const userId = auth.status === 'signedIn' ? auth.session.user.id : ''
  const session = useQuery({ queryKey: ['pos-session', userId], queryFn: () => getMyOpenSession(userId), enabled: Boolean(userId) })
  if (session.isPending) return <LoadingState />
  if (session.isError) return <ErrorState message={toAppError(session.error).message} onRetry={() => void session.refetch()} />
  return session.data ? <Till session={session.data} /> : <OpenShift />
}

// ---- no open session: start a shift -------------------------------------------------------------------------------
function OpenShift() {
  const { ability, selectedBranch } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const warehouses = useQuery({ queryKey: ['warehouse-options', null], queryFn: () => listWarehouseOptions(null), staleTime: 60_000 })
  const mine = (warehouses.data ?? []).filter((w) => w.is_active && ability.can('pos.sell', w.branch_id))
  const [warehouseId, setWarehouseId] = useState('')
  const [float, setFloat] = useState('0')
  const [error, setError] = useState<string | null>(null)
  const settings = useAppSettings()
  const chosen = warehouseId || (mine.find((w) => w.id === settings.defaultSalesWarehouse) ?? mine.find((w) => w.branch_id === selectedBranch) ?? mine[0])?.id || ''
  const open = useMutation({
    mutationFn: () => openPosSession(chosen, Number(float)),
    onSuccess: async () => { toast.success('Shift started.'); await qc.invalidateQueries({ queryKey: ['pos-session'] }) },
    onError: (e) => setError(toAppError(e).message),
  })
  function submit(e: FormEvent) {
    e.preventDefault()
    const n = Number(float)
    if (!chosen) { setError('Choose the warehouse you are selling from.'); return }
    if (float.trim() === '' || !Number.isFinite(n) || n < 0 || Math.abs(round2(n) - n) > 1e-9) { setError('Enter the cash float in the drawer (0 or more, at most 2 decimals).'); return }
    setError(null)
    open.mutate()
  }
  return (
    <>
      <PageHeader title="Point of sale" description="Start a shift to sell at the counter. Everything you sell and take is tallied against it when you close." />
      <Card className="max-w-lg">
        <CardBody>
          <form onSubmit={submit} noValidate className="space-y-4">
            <InlineError message={error} />
            {warehouses.isSuccess && mine.length === 0 && <p className="text-sm text-slate-600">You are not set up to sell at any warehouse.</p>}
            <Field label="Sell from" required>
              <Select value={chosen} onChange={(e) => setWarehouseId(e.target.value)}>
                <option value="">Select…</option>
                {mine.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </Field>
            <Field label="Cash float in the drawer" required hint="The notes and coins you start with."><Input type="number" inputMode="decimal" min="0" step="0.01" value={float} onChange={(e) => setFloat(e.target.value)} /></Field>
            <Button type="submit" loading={open.isPending} disabled={mine.length === 0}>Start shift</Button>
          </form>
        </CardBody>
      </Card>
    </>
  )
}

// ---- the till -------------------------------------------------------------------------------------------------------
function Till({ session }: { session: PosSession }) {
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const walkIn = useQuery({ queryKey: ['walk-in'], queryFn: getWalkInCustomer, staleTime: 5 * 60_000 })
  const customers = useQuery({ queryKey: ['customer-options'], queryFn: listCustomerOptions, staleTime: 60_000 })
  const taxCodes = useQuery({ queryKey: ['tax-codes'], queryFn: listTaxCodes, staleTime: 60_000 })
  const summary = useQuery({ queryKey: ['pos-summary', session.id], queryFn: () => getSessionSummary(session.id), refetchInterval: 60_000 })
  const [customerId, setCustomerId] = useState('')
  const [cart, setCart] = useState<SalesLineDraft[]>([])
  const [text, setText] = useState('')
  const [searching, setSearching] = useState(false)
  const [found, setFound] = useState<ProductRow[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [paying, setPaying] = useState(false)
  const [done, setDone] = useState<CheckoutResult | null>(null)
  const [closing, setClosing] = useState(false)

  const rights = { canOverridePrice: ability.can('sales.price_override', session.branch_id), canDiscount: ability.can('sales.discount', session.branch_id) }
  const built = buildSalesLines(cart, rights)
  const priceCustomer = customerId || walkIn.data?.id || ''
  const defaultTax = (taxCodes.data ?? []).find((t) => t.is_default)
  const taxRateFor = (id: string | null) => Number((taxCodes.data ?? []).find((t) => t.id === id)?.rate ?? defaultTax?.rate ?? 0)
  const patch = (key: string, p: Partial<SalesLineDraft>) => setCart((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))

  async function priceFor(cust: string, productId: string, unitId: string): Promise<number | null> {
    if (!cust) return null
    const unitRowId = unitId || (await qc.fetchQuery({ queryKey: ['product-units', productId], queryFn: () => listProductUnits(productId), staleTime: 60_000 })).find((u) => u.is_base)?.id
    return unitRowId ? resolvePrice(cust, unitRowId) : null
  }

  async function addProduct(p: ProductRow) {
    setMessage(null)
    const existing = cart.find((l) => l.product?.id === p.id && l.unitId === '' && l.price === '')
    if (existing) { patch(existing.key, { quantity: String(Number(existing.quantity || '0') + 1) }); return }
    const key = nextKey()
    setCart((rs) => [...rs, { ...emptySalesLine(key), product: p, quantity: '1' }])
    try {
      const [detail, price] = await Promise.all([
        qc.fetchQuery({ queryKey: ['product', p.id], queryFn: () => getProduct(p.id), staleTime: 60_000 }),
        priceFor(priceCustomer, p.id, ''),
      ])
      patch(key, { listPrice: price, taxRate: taxRateFor(detail?.tax_code_id ?? null) })
    } catch (e) { setMessage(toAppError(e).message) }
  }

  async function search(e: FormEvent) {
    e.preventDefault()
    const term = text.trim()
    if (term.length < 2) return
    setSearching(true)
    try {
      const res = await listProducts({ page: 0, pageSize: 8, search: term, status: 'active', productClass: '', categoryId: '' })
      if (res.rows.length === 1 || (res.rows[0] && [res.rows[0].sku.toLowerCase()].includes(term.toLowerCase()))) {
        await addProduct(res.rows[0]!)
        setText(''); setFound([])
      } else {
        setFound(res.rows)
        if (res.rows.length === 0) setMessage('No active product matches that.')
      }
    } catch (err) { setMessage(toAppError(err).message) } finally { setSearching(false) }
  }

  async function changeCustomer(id: string) {
    setCustomerId(id)
    const cust = id || walkIn.data?.id || ''
    const snapshot = cart
    const prices = await Promise.all(snapshot.map((r) => (r.product ? priceFor(cust, r.product.id, r.unitId) : Promise.resolve(null))))
    setCart((rs) => rs.map((r) => { const i = snapshot.findIndex((s) => s.key === r.key); return i >= 0 && r.product ? { ...r, listPrice: prices[i] ?? null } : r }))
  }

  const total = built.ok ? built.total : 0
  const customerName = customerId ? (customers.data ?? []).find((c) => c.id === customerId)?.name : walkIn.data?.name

  return (
    <>
      <PageHeader
        title="Point of sale"
        description={`${session.session_number} · ${session.warehouse?.name ?? ''} · started ${formatDateTime(session.opened_at)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {summary.data && <Badge tone="green">{summary.data.sales_count} sale{summary.data.sales_count === 1 ? '' : 's'} · {moneyFmt(summary.data.sales_total)}</Badge>}
            <Link to="/pos/sessions"><Button variant="ghost">Shifts</Button></Link>
            <Button variant="secondary" onClick={() => setClosing(true)}>Close shift</Button>
          </div>
        }
      />
      <div className="grid gap-5 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardBody className="space-y-3">
              <form onSubmit={(e) => void search(e)} className="flex gap-2">
                <Input aria-label="Scan or search products" placeholder="Scan barcode or type name / SKU, then Enter" value={text} onChange={(e) => setText(e.target.value)} autoFocus autoComplete="off" />
                <Button type="submit" loading={searching}>Add</Button>
              </form>
              {message && <p role="alert" className="text-sm text-red-700">{message}</p>}
              {found.length > 0 && (
                <ul className="divide-y divide-slate-100 rounded-md border border-slate-200" aria-label="Matching products">
                  {found.map((p) => (
                    <li key={p.id}>
                      <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => { void addProduct(p); setFound([]); setText('') }}>
                        <span className="min-w-0"><span className="font-medium text-slate-900">{p.brand_name}</span><span className="block truncate text-xs text-slate-500">{[p.sku, p.generic_name, p.strength_text].filter(Boolean).join(' · ')}</span></span>
                        <Plus className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <Field label="Customer">
                <Select value={customerId} onChange={(e) => void changeCustomer(e.target.value)}>
                  <option value="">{walkIn.data?.name ?? 'Walk-in customer'}</option>
                  {(customers.data ?? []).filter((c) => c.is_active && c.id !== walkIn.data?.id).map((c) => <option key={c.id} value={c.id}>{c.name}{c.on_hold ? ' - ON HOLD' : ''}</option>)}
                </Select>
              </Field>
              <p className="text-xs text-slate-500">Walk-in customers pay in full now and can only buy products that need no prescription.</p>
            </CardBody>
          </Card>
        </div>

        <div className="space-y-4 lg:col-span-3">
          <Card>
            <CardHeader title="Sale" actions={cart.length > 0 && <Button size="sm" variant="ghost" onClick={() => setCart([])}>Clear</Button>} />
            <CardBody className="space-y-2">
              {cart.length === 0 && <p className="py-6 text-center text-sm text-slate-500">Scan or search a product to start.</p>}
              {cart.map((r) => <CartRow key={r.key} row={r} rights={rights} onChange={(p) => patch(r.key, p)} onRemove={() => setCart((rs) => rs.filter((x) => x.key !== r.key))} priceFor={(unit) => (r.product ? priceFor(priceCustomer, r.product.id, unit) : Promise.resolve(null))} />)}
              {cart.length > 0 && !built.ok && <p className="text-sm text-amber-800">{built.error}</p>}
            </CardBody>
          </Card>
          <Card>
            <CardBody className="flex flex-wrap items-center justify-between gap-4">
              <dl className="space-y-0.5 text-sm">
                <div className="flex gap-6"><dt className="text-slate-500">Subtotal</dt><dd className="tabular-nums">{built.ok ? moneyFmt(built.subtotal) : '—'}</dd></div>
                <div className="flex gap-6"><dt className="text-slate-500">Tax</dt><dd className="tabular-nums">{built.ok ? moneyFmt(built.tax) : '—'}</dd></div>
              </dl>
              <div className="text-right">
                <p className="text-xs uppercase tracking-wide text-slate-500">Total</p>
                <p className="text-3xl font-bold tabular-nums text-slate-900">{built.ok ? moneyFmt(built.total) : '—'}</p>
              </div>
              <Button disabled={!built.ok} onClick={() => setPaying(true)}>Charge…</Button>
            </CardBody>
          </Card>
        </div>
      </div>

      {paying && built.ok && (
        <PaymentDialog
          total={total} customerName={customerName ?? ''} onAccount={Boolean(customerId)} canOverride={ability.can('sales.override_credit', session.branch_id)}
          onClose={() => setPaying(false)}
          onPay={async (payments, overrideReason) => {
            const r = await posCheckout({ sessionId: session.id, customerId: customerId || null, lines: built.lines, payments, ...(overrideReason ? { overrideReason } : {}) })
            setPaying(false)
            setCart([])
            setDone(r)
            await Promise.all(['pos-summary', 'sales-invoices', 'balances', 'customer-credit', 'dashboard', 'stock-documents'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
          }}
        />
      )}
      {done && (
        <Modal
          open size="md" onClose={() => setDone(null)} title={`Sale complete · ${done.invoice_number}`}
          footer={<><Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" aria-hidden /> Print receipt</Button><Button onClick={() => setDone(null)}>New sale</Button></>}
        >
          <div className="space-y-3">
            {done.change > 0 && <p className="rounded-md bg-green-50 px-3 py-2 text-center text-lg font-semibold text-green-800">Change to give: {moneyFmt(done.change)}</p>}
            {done.owed > 0 && <p className="rounded-md bg-amber-50 px-3 py-2 text-center text-sm text-amber-900">{moneyFmt(done.owed)} left on the customer’s account.</p>}
            <PosReceipt sale={done} />
          </div>
        </Modal>
      )}
      {closing && <CloseShiftDialog session={session} onClose={() => setClosing(false)} onClosed={() => { toast.success('Shift closed.'); void qc.invalidateQueries({ queryKey: ['pos-session'] }) }} />}
    </>
  )
}

function CartRow({ row, rights, onChange, onRemove, priceFor }: {
  row: SalesLineDraft
  rights: { canOverridePrice: boolean; canDiscount: boolean }
  onChange: (p: Partial<SalesLineDraft>) => void
  onRemove: () => void
  priceFor: (unitId: string) => Promise<number | null>
}) {
  const pid = row.product?.id
  const units = useQuery({ queryKey: ['product-units', pid], queryFn: () => listProductUnits(pid!), enabled: Boolean(pid), staleTime: 60_000 })
  const usable = (units.data ?? []).filter((u) => u.is_active && u.is_sellable)
  const qty = Number(row.quantity)
  const price = effectivePrice(row)
  const calc = price !== null && Number.isFinite(qty) && qty > 0 ? computeLine(qty, price, Number(row.discount) || 0, row.taxRate) : null
  const step = (d: number) => onChange({ quantity: String(Math.max(0, (Number.isFinite(qty) ? qty : 0) + d)) })
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><p className="truncate text-sm font-medium text-slate-900">{row.product?.brand_name}</p><p className="text-xs text-slate-500">{row.product?.sku}{row.listPrice === null ? ' · no price' : ''}</p></div>
        <button type="button" onClick={onRemove} aria-label={`Remove ${row.product?.brand_name}`} className="text-slate-400 hover:text-red-600"><Trash2 className="h-4 w-4" aria-hidden /></button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <div className="flex items-center">
          <Button type="button" size="sm" variant="secondary" onClick={() => step(-1)} aria-label="One less"><Minus className="h-3.5 w-3.5" aria-hidden /></Button>
          <Input aria-label="Quantity" type="number" inputMode="decimal" min="0" step="any" className="mx-1 h-8 w-20 text-center" value={row.quantity} onChange={(e) => onChange({ quantity: e.target.value })} />
          <Button type="button" size="sm" variant="secondary" onClick={() => step(1)} aria-label="One more"><Plus className="h-3.5 w-3.5" aria-hidden /></Button>
        </div>
        {usable.filter((u) => !u.is_base).length > 0 && (
          <Select aria-label="Pack" className="h-8 w-32" value={row.unitId} onChange={(e) => { const u = usable.find((x) => x.id === e.target.value); onChange({ unitId: e.target.value, factor: Number(u?.factor_to_base ?? 1), listPrice: null, price: '' }); void priceFor(e.target.value).then((p) => onChange({ listPrice: p })) }}>
            <option value="">{usable.find((u) => u.is_base)?.unit?.name ?? 'Unit'}</option>
            {usable.filter((u) => !u.is_base).map((u) => <option key={u.id} value={u.id}>{u.unit?.name} (×{Number(u.factor_to_base)})</option>)}
          </Select>
        )}
        <Input aria-label="Price" type="number" inputMode="decimal" min="0" step="any" className="h-8 w-24" placeholder={row.listPrice === null ? 'Price' : String(row.listPrice)} value={row.price} onChange={(e) => onChange({ price: e.target.value })} disabled={!rights.canOverridePrice && row.listPrice !== null} />
        {rights.canDiscount && <Input aria-label="Discount percent" type="number" inputMode="decimal" min="0" max="100" step="0.01" className="h-8 w-20" placeholder="Disc %" value={row.discount} onChange={(e) => onChange({ discount: e.target.value })} />}
        <span className="ml-auto text-sm font-semibold tabular-nums text-slate-900">{calc ? moneyFmt(calc.total) : '—'}</span>
      </div>
    </div>
  )
}

// ---- taking payment ---------------------------------------------------------------------------------------------------
interface PayRow { key: string; method: ReceiptMethod; amount: string; reference: string }

function PaymentDialog({ total, customerName, onAccount, canOverride, onClose, onPay }: {
  total: number
  customerName: string
  onAccount: boolean
  canOverride: boolean
  onClose: () => void
  onPay: (payments: PosPayment[], overrideReason?: string) => Promise<void>
}) {
  const [rows, setRows] = useState<PayRow[]>([{ key: nextKey(), method: 'CASH', amount: '', reference: '' }])
  const [override, setOverride] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const num = (v: string) => (v.trim() === '' ? 0 : Number(v))
  const cash = rows.filter((r) => r.method === 'CASH').reduce((s, r) => s + num(r.amount), 0)
  const other = rows.filter((r) => r.method !== 'CASH').reduce((s, r) => s + num(r.amount), 0)
  const due = round2(total - other)
  const kept = Math.min(cash, Math.max(0, due))
  const change = round2(cash - kept)
  const stillOwed = round2(total - other - kept)
  const patch = (key: string, p: Partial<PayRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))

  async function submit(e: FormEvent) {
    e.preventDefault()
    const payments: PosPayment[] = []
    for (const r of rows) {
      if (r.amount.trim() === '') continue
      const n = Number(r.amount)
      if (!Number.isFinite(n) || n <= 0 || Math.abs(round2(n) - n) > 1e-9) { setError('Each amount must be above 0 with at most 2 decimals.'); return }
      if (r.method !== 'CASH' && !r.reference.trim()) { setError(`Enter the reference for the ${RECEIPT_METHOD_LABEL[r.method].toLowerCase()} payment.`); return }
      payments.push({ method: r.method, amount: n, ...(r.reference.trim() ? { reference: r.reference.trim() } : {}) })
    }
    if (other > total + 1e-9) { setError('Card / mobile money / bank payments cannot be more than the total.'); return }
    if (stillOwed > 0 && !onAccount) { setError(`${moneyFmt(stillOwed)} is still unpaid. Walk-in customers must pay in full.`); return }
    setError(null)
    setBusy(true)
    try { await onPay(payments, override.trim() || undefined) } catch (err) { setError(toAppError(err).message); setBusy(false) }
  }

  return (
    <Modal
      open size="md" onClose={onClose} title={`Charge ${moneyFmt(total)}`} description={customerName}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Back</Button><Button type="submit" form="pos-pay" loading={busy}>Complete sale</Button></>}
    >
      <form id="pos-pay" onSubmit={(e) => void submit(e)} noValidate className="space-y-3">
        <InlineError message={error} />
        {rows.map((r) => (
          <div key={r.key} className="grid grid-cols-12 items-end gap-2">
            <Field label="How" className="col-span-4"><Select value={r.method} onChange={(e) => patch(r.key, { method: e.target.value as ReceiptMethod })}>{POS_METHODS.map((m) => <option key={m} value={m}>{RECEIPT_METHOD_LABEL[m]}</option>)}</Select></Field>
            <Field label={r.method === 'CASH' ? 'Handed over' : 'Amount'} className="col-span-4">
              <Input type="number" inputMode="decimal" min="0" step="0.01" value={r.amount} onChange={(e) => patch(r.key, { amount: e.target.value })} autoFocus={rows[0]?.key === r.key} />
            </Field>
            {r.method !== 'CASH' ? <Field label="Reference" className="col-span-3"><Input value={r.reference} maxLength={100} onChange={(e) => patch(r.key, { reference: e.target.value })} /></Field> : <div className="col-span-3 pb-1"><Button type="button" size="sm" variant="secondary" onClick={() => patch(r.key, { amount: String(Math.max(0, due)) })}>Exact</Button></div>}
            {rows.length > 1 && <button type="button" className="col-span-1 pb-2 text-slate-400 hover:text-red-600" aria-label="Remove payment" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><Trash2 className="h-4 w-4" aria-hidden /></button>}
          </div>
        ))}
        {rows.length < 5 && <Button type="button" size="sm" variant="ghost" onClick={() => setRows((rs) => [...rs, { key: nextKey(), method: 'MOBILE_MONEY', amount: '', reference: '' }])}><Plus className="h-4 w-4" aria-hidden /> Split payment</Button>}
        <dl className="space-y-1 rounded-md bg-slate-50 p-3 text-sm">
          <div className="flex justify-between"><dt className="text-slate-500">Total</dt><dd className="tabular-nums">{moneyFmt(total)}</dd></div>
          <div className="flex justify-between"><dt className="text-slate-500">Received</dt><dd className="tabular-nums">{moneyFmt(kept + other)}</dd></div>
          {change > 0 && <div className="flex justify-between text-base font-semibold text-green-800"><dt>Change</dt><dd className="tabular-nums">{moneyFmt(change)}</dd></div>}
          {stillOwed > 0 && <div className="flex justify-between font-semibold text-amber-800"><dt>{onAccount ? 'On account' : 'Still to pay'}</dt><dd className="tabular-nums">{moneyFmt(stillOwed)}</dd></div>}
        </dl>
        {onAccount && stillOwed > 0 && canOverride && (
          <Field label="Reason to sell past a credit hold or limit (only if refused)" hint="Recorded in the audit trail."><Textarea rows={2} maxLength={300} value={override} onChange={(e) => setOverride(e.target.value)} /></Field>
        )}
      </form>
    </Modal>
  )
}

// ---- closing the shift ---------------------------------------------------------------------------------------------------
export function CloseShiftDialog({ session, onClose, onClosed }: { session: PosSession; onClose: () => void; onClosed: () => void }) {
  const summary = useQuery({ queryKey: ['pos-summary', session.id], queryFn: () => getSessionSummary(session.id) })
  const qc = useQueryClient()
  const [counted, setCounted] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const expected = summary.data?.expected_cash ?? 0
  const diff = counted.trim() === '' ? null : round2(Number(counted) - expected)
  const close = useMutation({
    mutationFn: () => closePosSession(session.id, Number(counted), notes),
    onSuccess: async () => { await Promise.all(['pos-session', 'pos-sessions', 'pos-summary'].map((k) => qc.invalidateQueries({ queryKey: [k] }))); onClosed(); onClose() },
    onError: (e) => setError(toAppError(e).message),
  })
  function submit(e: FormEvent) {
    e.preventDefault()
    const n = Number(counted)
    if (counted.trim() === '' || !Number.isFinite(n) || n < 0 || Math.abs(round2(n) - n) > 1e-9) { setError('Count the cash in the drawer and enter it (0 or more, at most 2 decimals).'); return }
    if (diff !== 0 && !notes.trim()) { setError('The cash does not match what was expected: explain the difference in the notes.'); return }
    setError(null)
    close.mutate()
  }
  return (
    <Modal
      open size="md" onClose={onClose} title={`Close shift ${session.session_number}`} description="Count the cash in the drawer. The system compares it with the float plus the cash taken."
      footer={<><Button variant="secondary" onClick={onClose} disabled={close.isPending}>Back</Button><Button type="submit" form="close-shift" loading={close.isPending} disabled={!summary.data}>Close shift</Button></>}
    >
      <form id="close-shift" onSubmit={submit} noValidate className="space-y-3">
        <InlineError message={error} />
        {summary.isPending ? <LoadingState /> : summary.data && (
          <dl className="space-y-1 rounded-md bg-slate-50 p-3 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">Sales</dt><dd>{summary.data.sales_count} · {moneyFmt(summary.data.sales_total)}</dd></div>
            {summary.data.by_method.map((m) => <div key={m.method} className="flex justify-between"><dt className="text-slate-500">{RECEIPT_METHOD_LABEL[m.method]}</dt><dd className="tabular-nums">{moneyFmt(m.amount)}</dd></div>)}
            <div className="flex justify-between"><dt className="text-slate-500">Opening float</dt><dd className="tabular-nums">{moneyFmt(summary.data.opening_float)}</dd></div>
            <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold"><dt>Cash expected in the drawer</dt><dd className="tabular-nums">{moneyFmt(summary.data.expected_cash)}</dd></div>
          </dl>
        )}
        <Field label="Cash counted" required><Input type="number" inputMode="decimal" min="0" step="0.01" value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus /></Field>
        {diff !== null && diff !== 0 && <p className={`text-sm font-medium ${diff < 0 ? 'text-red-700' : 'text-amber-800'}`}>{diff < 0 ? `Short by ${moneyFmt(-diff)}` : `Over by ${moneyFmt(diff)}`}</p>}
        {diff !== null && diff === 0 && <p className="text-sm font-medium text-green-700">The drawer balances.</p>}
        <Field label="Notes" hint="Required when the cash does not match."><Textarea rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </form>
    </Modal>
  )
}
