import { useQuery } from '@tanstack/react-query'
import { Download, FileDown, Printer } from 'lucide-react'
import { useState } from 'react'
import { Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, LoadingState, PageHeader, Select, useToast } from '@/components/ui'
import { downloadCsv } from '@/lib/download'
import { toAppError } from '@/lib/errors'
import { downloadTablePdf } from '@/lib/pdf'
import { formatDateTime } from '@/lib/utils'
import { useSession } from '@/modules/session/SessionProvider'
import { fmtQty } from '@/services/inventory'
import { getControlledRegister, getControlledSummary, type ControlledSummaryRow, type RegisterLine } from '@/services/reports'
import { listWarehouseOptions } from '@/services/warehouses'

const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
const monthStart = () => { const d = new Date(); d.setDate(1); return iso(d) }

const MOVEMENT_LABEL: Record<string, string> = {
  OPENING_BALANCE: 'Brought forward', OPENING: 'Opening stock', RECEIPT: 'Received from supplier', SALE_OUT: 'Sold', SALE_RETURN_IN: 'Returned by customer',
  SALE_REVERSAL_IN: 'Sale reversed', SALE_RETURN_REVERSAL_OUT: 'Customer return reversed', RETURN_OUT: 'Returned to supplier', ADJUSTMENT_IN: 'Adjustment (in)',
  ADJUSTMENT_OUT: 'Adjustment (out)', TRANSFER_IN: 'Transfer in', TRANSFER_OUT: 'Transfer out',
}

export function ControlledRegisterPage() {
  const { context } = useSession()
  const toast = useToast()
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(iso(new Date()))
  const [warehouseId, setWarehouseId] = useState('')
  const [product, setProduct] = useState<ControlledSummaryRow | null>(null)
  const valid = from !== '' && to !== '' && from <= to
  const warehouses = useQuery({ queryKey: ['warehouse-options', null], queryFn: () => listWarehouseOptions(null), staleTime: 60_000 })
  const summary = useQuery({ queryKey: ['controlled-summary', from, to, warehouseId], queryFn: () => getControlledSummary(from, to, warehouseId || null), enabled: valid })
  const register = useQuery({
    queryKey: ['controlled-register', product?.product_id, from, to, warehouseId],
    queryFn: () => getControlledRegister(product!.product_id, from, to, warehouseId || null),
    enabled: valid && product !== null,
  })
  const lines = register.data ?? []
  const where = warehouseId ? (warehouses.data ?? []).find((w) => w.id === warehouseId)?.name ?? '' : 'all warehouses'
  const orgName = context.organization?.name ?? ''

  const out = (l: RegisterLine) => (l.quantity !== null && l.quantity < 0 ? fmtQty(-l.quantity) : '')
  const inn = (l: RegisterLine) => (l.quantity !== null && l.quantity > 0 ? fmtQty(l.quantity) : '')
  const who = (l: RegisterLine) => [l.counterparty, l.licence_number ? `licence ${l.licence_number}` : null].filter(Boolean).join(' · ')
  const header = ['Date', 'Document', 'Movement', 'Batch', 'Expiry', 'In', 'Out', 'Balance', 'Customer / supplier', 'Reference', 'Posted by', 'Notes']
  const cells = (l: RegisterLine) => [formatDateTime(l.posted_at), l.document_number ?? '', MOVEMENT_LABEL[l.movement_type] ?? l.movement_type, l.batch_number ?? '', l.expiry_date ?? '',
    inn(l), out(l), fmtQty(l.balance), who(l), l.reference ?? '', l.posted_by_name ?? '', l.is_opening ? '' : l.notes ?? '']

  async function pdf() {
    if (!product) return
    try {
      await downloadTablePdf({
        title: `Controlled drugs register: ${product.product_name} (${product.sku})`, subtitle: `${from} to ${to} · ${where} · quantities in base units`, organization: orgName, landscape: true,
        filename: `controlled-register-${product.sku}-${from}-to-${to}`,
        columns: header.map((h, i) => ({ header: h, align: [5, 6, 7].includes(i) ? 'right' : 'left' })), rows: lines.map(cells),
      })
    } catch (e) { toast.error(toAppError(e).message) }
  }
  const csv = () => product && downloadCsv(`controlled-register-${product.sku}-${from}-to-${to}`, [header, ...lines.map(cells)])

  return (
    <>
      <div className="print-hidden">
        <PageHeader title="Controlled drugs register" description="Every movement of each controlled medicine, with the running balance, batch, who it came from or went to, and who posted it." />
        <Card>
          <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:flex-wrap sm:items-end">
            <Field label="From"><Input type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); setProduct(null) }} /></Field>
            <Field label="To"><Input type="date" value={to} min={from} onChange={(e) => { setTo(e.target.value); setProduct(null) }} /></Field>
            <Field label="Warehouse">
              <Select value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setProduct(null) }}>
                <option value="">All I can see</option>
                {(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </Field>
          </div>
          {!valid ? <p className="p-4 text-sm text-amber-800">Choose a start date that is not after the end date.</p>
            : summary.isPending ? <LoadingState />
            : summary.isError ? <ErrorState message={toAppError(summary.error).message} onRetry={() => void summary.refetch()} />
            : (summary.data ?? []).length === 0 ? <EmptyState title="No controlled medicines" description="Products of the class “Controlled” appear here." />
            : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <caption className="sr-only">Controlled medicines in the period</caption>
                  <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr><th className="px-4 py-2">Product</th><th className="px-4 text-right">Opening</th><th className="px-4 text-right">Received</th><th className="px-4 text-right">Issued</th><th className="px-4 text-right">Adjusted</th><th className="px-4 text-right">Closing</th><th className="px-4" /></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(summary.data ?? []).map((s) => (
                      <tr key={s.product_id} className={product?.product_id === s.product_id ? 'bg-brand-50' : ''}>
                        <td className="px-4 py-2"><span className="font-medium text-slate-900">{s.product_name}</span> <span className="text-xs text-slate-500">{s.sku}</span></td>
                        <td className="px-4 text-right tabular-nums">{fmtQty(s.opening)}</td>
                        <td className="px-4 text-right tabular-nums">{fmtQty(s.received)}</td>
                        <td className="px-4 text-right tabular-nums">{fmtQty(s.issued)}</td>
                        <td className="px-4 text-right tabular-nums">{s.adjusted === 0 ? '—' : fmtQty(s.adjusted)}</td>
                        <td className="px-4 text-right font-semibold tabular-nums">{fmtQty(s.closing)}</td>
                        <td className="px-4 text-right"><Button size="sm" variant={product?.product_id === s.product_id ? 'primary' : 'secondary'} onClick={() => setProduct(s)}>Register</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </Card>
      </div>

      {product && (
        <div className="mt-5">
          <Card>
            <div className="print-hidden">
              <CardHeader
                title={`${product.product_name} (${product.sku})`}
                description={`${from} to ${to} · ${where} · quantities in base units`}
                actions={
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={csv} disabled={lines.length === 0}><Download className="h-4 w-4" aria-hidden /> CSV</Button>
                    <Button size="sm" variant="secondary" onClick={() => void pdf()} disabled={lines.length === 0}><FileDown className="h-4 w-4" aria-hidden /> PDF</Button>
                    <Button size="sm" variant="secondary" onClick={() => window.print()} disabled={lines.length === 0}><Printer className="h-4 w-4" aria-hidden /> Print</Button>
                  </div>
                }
              />
            </div>
            {register.isPending ? <LoadingState /> : register.isError ? <ErrorState message={toAppError(register.error).message} onRetry={() => void register.refetch()} /> : (
              <div id="print-area" className="overflow-x-auto bg-white p-2">
                <p className="mb-2 hidden text-sm font-semibold print:block">{orgName} — Controlled drugs register: {product.product_name} ({product.sku}), {from} to {to}, {where}</p>
                <table className="min-w-full text-xs">
                  <caption className="sr-only">Register of {product.product_name}</caption>
                  <thead className="border-b border-slate-300 text-left uppercase tracking-wide text-slate-500">
                    <tr>{header.map((h, i) => <th key={h} className={`px-2 py-1.5 ${[5, 6, 7].includes(i) ? 'text-right' : ''}`}>{h}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {lines.map((l) => (
                      <tr key={l.line_no} className={l.is_opening ? 'bg-slate-50 font-medium' : ''}>
                        {cells(l).map((c, i) => <td key={i} className={`px-2 py-1.5 ${[5, 6, 7].includes(i) ? 'text-right tabular-nums' : ''} ${i === 7 ? 'font-semibold' : ''}`}>{c}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {lines.length <= 1 && <p className="p-3 text-xs text-slate-500">No movements in this period.</p>}
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  )
}
