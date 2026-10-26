import { useQuery } from '@tanstack/react-query'
import { Download, FileDown } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, PageHeader, Select, Tabs, useToast } from '@/components/ui'
import { downloadCsv } from '@/lib/download'
import { toAppError } from '@/lib/errors'
import { downloadTablePdf } from '@/lib/pdf'
import { useSession } from '@/modules/session/SessionProvider'
import { fmtQty } from '@/services/inventory'
import { getExpiryRisk, getReorderSuggestions, getSlowMoving } from '@/services/insights'
import { moneyFmt } from '@/services/sales'
import { listWarehouseOptions } from '@/services/warehouses'

export function StockInsightsPage() {
  const [tab, setTab] = useState('reorder')
  return (
    <>
      <PageHeader title="Stock insights" description="What to buy, what is not selling, and what is likely to expire unsold. All figures are estimates from recent sales." />
      <Tabs label="Stock insight reports" value={tab} onChange={setTab} items={[{ id: 'reorder', label: 'Reorder suggestions' }, { id: 'slow', label: 'Slow-moving stock' }, { id: 'expiry', label: 'Likely to expire' }]} />
      <div className="mt-4">{tab === 'reorder' ? <Reorder /> : tab === 'slow' ? <Slow /> : <ExpiryRisk />}</div>
    </>
  )
}

function Shell({ toolbar, exports, children, loading, error, onRetry, empty, emptyTitle, emptyText }: {
  toolbar: ReactNode
  exports: { csv: () => void; pdf: () => void; disabled: boolean }
  children: ReactNode
  loading: boolean
  error: string | null
  onRetry: () => void
  empty: boolean
  emptyTitle: string
  emptyText: string
}) {
  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:flex-wrap sm:items-end">
        {toolbar}
        <div className="flex gap-2 sm:ml-auto">
          <Button variant="secondary" onClick={exports.csv} disabled={exports.disabled}><Download className="h-4 w-4" aria-hidden /> CSV</Button>
          <Button variant="secondary" onClick={exports.pdf} disabled={exports.disabled}><FileDown className="h-4 w-4" aria-hidden /> PDF</Button>
        </div>
      </div>
      {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={onRetry} /> : empty ? <EmptyState title={emptyTitle} description={emptyText} /> : <div className="overflow-x-auto">{children}</div>}
    </Card>
  )
}

const th = 'px-4 py-2'
const head = (cols: string[], rightFrom: number) => <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500"><tr>{cols.map((c, i) => <th key={c} className={`${th} ${i >= rightFrom ? 'text-right' : ''}`}>{c}</th>)}</tr></thead>

function Reorder() {
  const { context } = useSession()
  const toast = useToast()
  const [history, setHistory] = useState('90')
  const [cover, setCover] = useState('30')
  const [warehouseId, setWarehouseId] = useState('')
  const warehouses = useQuery({ queryKey: ['warehouse-options', null], queryFn: () => listWarehouseOptions(null), staleTime: 60_000 })
  const ok = Number(history) >= 7 && Number(history) <= 730 && Number(cover) >= 1 && Number(cover) <= 365
  const query = useQuery({ queryKey: ['insight-reorder', warehouseId, history, cover], queryFn: () => getReorderSuggestions(warehouseId || null, Number(history), Number(cover)), enabled: ok })
  const rows = query.data ?? []
  const header = ['Product', 'Unit', 'In stock', 'Reserved', 'On order', 'Sells / day', 'Days of stock', 'Lead time (d)', 'Wanted', 'Buy', 'Preferred supplier']
  const cells = (r: (typeof rows)[number]) => [`${r.product_name} (${r.sku})`, r.base_unit, fmtQty(r.on_hand), fmtQty(r.reserved), fmtQty(r.on_order), String(r.avg_daily), r.days_cover === null ? '' : String(r.days_cover), String(r.lead_time_days), fmtQty(r.target_stock), fmtQty(r.suggested_qty), r.supplier_name ?? '']
  return (
    <Shell
      loading={query.isPending && ok} error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()} empty={rows.length === 0} emptyTitle="Nothing to suggest" emptyText="Products appear here once they have sold in the period."
      exports={{
        disabled: rows.length === 0, csv: () => downloadCsv('reorder-suggestions', [header, ...rows.map(cells)]),
        pdf: () => void downloadTablePdf({ title: 'Reorder suggestions', subtitle: `Sales of the last ${history} days; each purchase should cover ${cover} days after it arrives`, organization: context.organization?.name ?? '', landscape: true, filename: 'reorder-suggestions',
          columns: header.map((h, i) => ({ header: h, align: i >= 2 && i <= 9 ? 'right' : 'left' })), rows: rows.map(cells) }).catch((e) => toast.error(toAppError(e).message)),
      }}
      toolbar={<>
        <Field label="Average sales over (days)"><Input type="number" min="7" max="730" value={history} onChange={(e) => setHistory(e.target.value)} className="w-32" /></Field>
        <Field label="Each purchase should cover (days)"><Input type="number" min="1" max="365" value={cover} onChange={(e) => setCover(e.target.value)} className="w-32" /></Field>
        <Field label="Warehouse"><Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}><option value="">All I can see</option>{(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
      </>}
    >
      <table className="min-w-full text-sm">
        <caption className="sr-only">Reorder suggestions</caption>
        {head(header, 2)}
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.product_id} className={r.suggested_qty > 0 ? '' : 'text-slate-500'}>
              <td className="px-4 py-2"><span className="font-medium text-slate-900">{r.product_name}</span> <span className="text-xs text-slate-500">{r.sku}</span></td>
              <td className="px-4">{r.base_unit}</td>
              <td className="px-4 text-right tabular-nums">{fmtQty(r.on_hand)}</td>
              <td className="px-4 text-right tabular-nums">{r.reserved > 0 ? fmtQty(r.reserved) : '—'}</td>
              <td className="px-4 text-right tabular-nums">{r.on_order > 0 ? fmtQty(r.on_order) : '—'}</td>
              <td className="px-4 text-right tabular-nums">{r.avg_daily}</td>
              <td className={`px-4 text-right tabular-nums ${(r.days_cover ?? 99) < r.lead_time_days ? 'font-semibold text-red-700' : ''}`}>{r.days_cover ?? '—'}</td>
              <td className="px-4 text-right tabular-nums">{r.lead_time_days}</td>
              <td className="px-4 text-right tabular-nums">{fmtQty(r.target_stock)}</td>
              <td className="px-4 text-right font-semibold tabular-nums">{r.suggested_qty > 0 ? fmtQty(r.suggested_qty) : '—'}</td>
              <td className="px-4 text-slate-600">{r.supplier_name ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Shell>
  )
}

function Slow() {
  const { context } = useSession()
  const toast = useToast()
  const [days, setDays] = useState('180')
  const ok = Number(days) >= 30 && Number(days) <= 1460
  const query = useQuery({ queryKey: ['insight-slow', days], queryFn: () => getSlowMoving(Number(days)), enabled: ok })
  const rows = query.data ?? []
  const showValue = rows.length > 0 && rows.every((r) => r.stock_value !== null)
  const total = rows.reduce((s, r) => s + (r.stock_value ?? 0), 0)
  const header = ['Product', 'Unit', 'In stock', ...(showValue ? ['Value'] : []), 'Last sold', 'Days since', 'Earliest expiry']
  const cells = (r: (typeof rows)[number]) => [`${r.product_name} (${r.sku})`, r.base_unit, fmtQty(r.on_hand), ...(showValue ? [moneyFmt(r.stock_value)] : []), r.last_sale_date ?? 'never', r.days_since_sale === null ? '' : String(r.days_since_sale), r.earliest_expiry ?? '']
  return (
    <Shell
      loading={query.isPending && ok} error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()} empty={rows.length === 0} emptyTitle="No matching slow-moving stock" emptyText="No stock matches these filters. This can also occur when no stock has been recorded."
      exports={{
        disabled: rows.length === 0, csv: () => downloadCsv('slow-moving-stock', [header, ...rows.map(cells)]),
        pdf: () => void downloadTablePdf({ title: 'Slow-moving stock', subtitle: `Not sold for ${days} days or more${showValue ? ` · ${moneyFmt(total)} tied up` : ''}`, organization: context.organization?.name ?? '', filename: 'slow-moving-stock',
          columns: header.map((h, i) => ({ header: h, align: i >= 2 && i <= (showValue ? 3 : 2) ? 'right' : 'left' })), rows: rows.map(cells) }).catch((e) => toast.error(toAppError(e).message)),
      }}
      toolbar={<Field label="Not sold for (days)"><Input type="number" min="30" max="1460" value={days} onChange={(e) => setDays(e.target.value)} className="w-32" /></Field>}
    >
      <table className="min-w-full text-sm">
        <caption className="sr-only">Slow-moving stock</caption>
        {head(header, 2)}
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.product_id}>
              <td className="px-4 py-2"><span className="font-medium text-slate-900">{r.product_name}</span> <span className="text-xs text-slate-500">{r.sku}</span></td>
              <td className="px-4 text-right">{r.base_unit}</td>
              <td className="px-4 text-right tabular-nums">{fmtQty(r.on_hand)}</td>
              {showValue && <td className="px-4 text-right font-semibold tabular-nums">{moneyFmt(r.stock_value)}</td>}
              <td className="px-4 text-right">{r.last_sale_date ?? 'never'}</td>
              <td className="px-4 text-right tabular-nums">{r.days_since_sale ?? '—'}</td>
              <td className="px-4 text-right">{r.earliest_expiry ?? '—'}</td>
            </tr>
          ))}
        </tbody>
        {showValue && <tfoot className="border-t-2 border-slate-300 bg-slate-50 font-semibold"><tr><td className="px-4 py-2" colSpan={3}>Tied up in slow stock</td><td className="px-4 text-right tabular-nums">{moneyFmt(total)}</td><td colSpan={3} /></tr></tfoot>}
      </table>
    </Shell>
  )
}

function ExpiryRisk() {
  const { context } = useSession()
  const toast = useToast()
  const [horizon, setHorizon] = useState('180')
  const [history, setHistory] = useState('90')
  const ok = Number(horizon) >= 7 && Number(horizon) <= 1095 && Number(history) >= 7 && Number(history) <= 730
  const query = useQuery({ queryKey: ['insight-expiry', horizon, history], queryFn: () => getExpiryRisk(Number(horizon), Number(history), null), enabled: ok })
  const rows = query.data ?? []
  const showValue = rows.length > 0 && rows.every((r) => r.value_at_risk !== null)
  const total = rows.reduce((s, r) => s + (r.value_at_risk ?? 0), 0)
  const header = ['Product', 'Batch', 'Expires', 'Days left', 'In stock', 'Sells / day', 'Expected to sell', 'Likely unsold', ...(showValue ? ['Value at risk'] : [])]
  const cells = (r: (typeof rows)[number]) => [`${r.product_name} (${r.sku})`, r.batch_number, r.expiry_date, String(r.days_left), fmtQty(r.quantity), String(r.avg_daily), fmtQty(r.expected_sales), fmtQty(r.at_risk_qty), ...(showValue ? [moneyFmt(r.value_at_risk)] : [])]
  return (
    <Shell
      loading={query.isPending && ok} error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()} empty={rows.length === 0} emptyTitle="No matching expiry-risk records" emptyText="No batches match this estimate. Check that stock and sales history are available before using it for planning."
      exports={{
        disabled: rows.length === 0, csv: () => downloadCsv('expiry-risk', [header, ...rows.map(cells)]),
        pdf: () => void downloadTablePdf({ title: 'Stock likely to expire unsold', subtitle: `Batches expiring within ${horizon} days, at the sales pace of the last ${history} days, earliest expiry sold first${showValue ? ` · ${moneyFmt(total)} at risk` : ''}`,
          organization: context.organization?.name ?? '', landscape: true, filename: 'expiry-risk', columns: header.map((h, i) => ({ header: h, align: i >= 3 ? 'right' : 'left' })), rows: rows.map(cells) }).catch((e) => toast.error(toAppError(e).message)),
      }}
      toolbar={<>
        <Field label="Expiring within (days)"><Input type="number" min="7" max="1095" value={horizon} onChange={(e) => setHorizon(e.target.value)} className="w-32" /></Field>
        <Field label="Sales pace from the last (days)"><Input type="number" min="7" max="730" value={history} onChange={(e) => setHistory(e.target.value)} className="w-32" /></Field>
      </>}
    >
      <table className="min-w-full text-sm">
        <caption className="sr-only">Stock likely to expire unsold</caption>
        {head(header, 3)}
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={`${r.product_id}-${r.batch_number}`}>
              <td className="px-4 py-2"><span className="font-medium text-slate-900">{r.product_name}</span> <span className="text-xs text-slate-500">{r.sku}</span></td>
              <td className="px-4 font-mono text-xs">{r.batch_number}</td>
              <td className="px-4 whitespace-nowrap">{r.expiry_date}</td>
              <td className={`px-4 text-right tabular-nums ${r.days_left <= 30 ? 'font-semibold text-red-700' : ''}`}>{r.days_left}</td>
              <td className="px-4 text-right tabular-nums">{fmtQty(r.quantity)}</td>
              <td className="px-4 text-right tabular-nums">{r.avg_daily}</td>
              <td className="px-4 text-right tabular-nums">{fmtQty(r.expected_sales)}</td>
              <td className="px-4 text-right font-semibold tabular-nums">{fmtQty(r.at_risk_qty)}</td>
              {showValue && <td className="px-4 text-right tabular-nums">{moneyFmt(r.value_at_risk)}</td>}
            </tr>
          ))}
        </tbody>
        {showValue && <tfoot className="border-t-2 border-slate-300 bg-slate-50 font-semibold"><tr><td className="px-4 py-2" colSpan={8}>Total at risk</td><td className="px-4 text-right tabular-nums">{moneyFmt(total)}</td></tr></tfoot>}
      </table>
    </Shell>
  )
}
