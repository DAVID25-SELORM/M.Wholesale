import { useQuery } from '@tanstack/react-query'
import { Download, FileDown } from 'lucide-react'
import { useState } from 'react'
import { Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, PageHeader, Select, useToast } from '@/components/ui'
import { downloadCsv } from '@/lib/download'
import { toAppError } from '@/lib/errors'
import { downloadTablePdf } from '@/lib/pdf'
import { useSession } from '@/modules/session/SessionProvider'
import { REPORT_GROUPS, REPORT_GROUP_LABEL, getSalesReport, type ReportGroup, type SalesReportRow } from '@/services/reports'
import { moneyFmt, round2 } from '@/services/sales'

const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
const monthStart = () => { const d = new Date(); d.setDate(1); return iso(d) }

export function SalesReportPage() {
  const { branches, context } = useSession()
  const toast = useToast()
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(iso(new Date()))
  const [group, setGroup] = useState<ReportGroup>('DAY')
  const [branchId, setBranchId] = useState('')
  const valid = from !== '' && to !== '' && from <= to
  const query = useQuery({ queryKey: ['sales-report', from, to, group, branchId], queryFn: () => getSalesReport(from, to, group, branchId || null), enabled: valid })
  const rows = query.data ?? []
  const showCost = rows.length > 0 && rows.every((r) => r.cost !== null)
  const sum = (f: (r: SalesReportRow) => number | null) => rows.reduce((s, r) => s + (f(r) ?? 0), 0)
  const totals = {
    invoices: sum((r) => r.invoices), units: sum((r) => r.units), sales: sum((r) => r.sales), credits: sum((r) => r.credits), net: sum((r) => r.net_sales), tax: sum((r) => r.tax),
    cost: sum((r) => r.cost), margin: sum((r) => r.margin),
  }
  const pct = totals.net > 0 ? round2((totals.margin / totals.net) * 100) : null
  const uncosted = sum((r) => r.uncosted_lines)
  const orgName = context.organization?.name ?? ''

  const tableRows = () => rows.map((r) => [r.group_label, String(r.invoices), String(r.units), moneyFmt(r.sales), moneyFmt(r.credits), moneyFmt(r.net_sales), moneyFmt(r.tax),
    ...(showCost ? [moneyFmt(r.cost), moneyFmt(r.margin), r.margin_pct === null ? '' : `${r.margin_pct}%`] : [])])
  const headers = [REPORT_GROUP_LABEL[group], 'Invoices', 'Units', 'Sales', 'Credits', 'Net sales', 'Tax', ...(showCost ? ['Cost', 'Margin', 'Margin %'] : [])]

  async function pdf() {
    try {
      await downloadTablePdf({
        title: `Sales by ${REPORT_GROUP_LABEL[group].toLowerCase()}`, subtitle: `${from} to ${to}${branchId ? ` · ${branches.find((b) => b.id === branchId)?.name ?? ''}` : ''}`, organization: orgName,
        landscape: true, filename: `sales-by-${group.toLowerCase()}-${from}-to-${to}`,
        columns: headers.map((h, i) => ({ header: h, align: i === 0 ? 'left' : 'right' })), rows: tableRows(),
        footer: [['Total', String(totals.invoices), String(totals.units), moneyFmt(totals.sales), moneyFmt(totals.credits), moneyFmt(totals.net), moneyFmt(totals.tax),
          ...(showCost ? [moneyFmt(totals.cost), moneyFmt(totals.margin), pct === null ? '' : `${pct}%`] : [])]],
      })
    } catch (e) { toast.error(toAppError(e).message) }
  }
  function csv() {
    downloadCsv(`sales-by-${group.toLowerCase()}-${from}-to-${to}`, [headers, ...rows.map((r) => [r.group_label, r.invoices, r.units, r.sales, r.credits, r.net_sales, r.tax,
      ...(showCost ? [r.cost, r.margin, r.margin_pct] : [])])])
  }

  return (
    <>
      <PageHeader title="Sales and margins" description="Revenue from posted invoices, net of credit notes. Reversed invoices are excluded. Cost is what the goods were actually picked from." />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:flex-wrap sm:items-end">
          <Field label="From"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="Group by"><Select value={group} onChange={(e) => setGroup(e.target.value as ReportGroup)}>{REPORT_GROUPS.map((g) => <option key={g} value={g}>{REPORT_GROUP_LABEL[g]}</option>)}</Select></Field>
          {branches.length > 1 && (
            <Field label="Branch"><Select value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">All my branches</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          )}
          <div className="flex gap-2 sm:ml-auto">
            <Button variant="secondary" onClick={csv} disabled={rows.length === 0}><Download className="h-4 w-4" aria-hidden /> CSV</Button>
            <Button variant="secondary" onClick={() => void pdf()} disabled={rows.length === 0}><FileDown className="h-4 w-4" aria-hidden /> PDF</Button>
          </div>
        </div>
        {!valid ? <p className="p-4 text-sm text-amber-800">Choose a start date that is not after the end date.</p>
          : query.isPending ? <LoadingState />
          : query.isError ? <ErrorState message={toAppError(query.error).message} onRetry={() => void query.refetch()} />
          : rows.length === 0 ? <EmptyState title="No sales in this period" description="Posted invoices appear here; try a wider range." />
          : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <caption className="sr-only">Sales report</caption>
                <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>{headers.map((h, i) => <th key={h} className={`px-4 py-2 ${i === 0 ? '' : 'text-right'}`}>{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={r.group_key}>
                      <td className="px-4 py-2 font-medium text-slate-900">{r.group_label}</td>
                      <td className="px-4 text-right tabular-nums">{r.invoices}</td>
                      <td className="px-4 text-right tabular-nums">{r.units}</td>
                      <td className="px-4 text-right tabular-nums">{moneyFmt(r.sales)}</td>
                      <td className="px-4 text-right tabular-nums text-slate-500">{r.credits > 0 ? moneyFmt(r.credits) : '—'}</td>
                      <td className="px-4 text-right font-semibold tabular-nums">{moneyFmt(r.net_sales)}</td>
                      <td className="px-4 text-right tabular-nums text-slate-500">{moneyFmt(r.tax)}</td>
                      {showCost && <><td className="px-4 text-right tabular-nums">{moneyFmt(r.cost)}</td><td className="px-4 text-right tabular-nums">{moneyFmt(r.margin)}</td><td className={`px-4 text-right tabular-nums ${(r.margin_pct ?? 0) < 0 ? 'text-red-700' : ''}`}>{r.margin_pct === null ? '—' : `${r.margin_pct}%`}</td></>}
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                  <tr>
                    <td className="px-4 py-2">Total</td>
                    <td className="px-4 text-right tabular-nums">{totals.invoices}</td>
                    <td className="px-4 text-right tabular-nums">{totals.units}</td>
                    <td className="px-4 text-right tabular-nums">{moneyFmt(totals.sales)}</td>
                    <td className="px-4 text-right tabular-nums">{moneyFmt(totals.credits)}</td>
                    <td className="px-4 text-right tabular-nums">{moneyFmt(totals.net)}</td>
                    <td className="px-4 text-right tabular-nums">{moneyFmt(totals.tax)}</td>
                    {showCost && <><td className="px-4 text-right tabular-nums">{moneyFmt(totals.cost)}</td><td className="px-4 text-right tabular-nums">{moneyFmt(totals.margin)}</td><td className="px-4 text-right tabular-nums">{pct === null ? '—' : `${pct}%`}</td></>}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        {showCost && uncosted > 0 && <p className="border-t border-slate-100 p-4 text-sm text-amber-800">{uncosted} invoice line{uncosted === 1 ? ' was' : 's were'} sold from batches with no cost on record, so margins are overstated for them. Record batch costs to fix this.</p>}
        {!showCost && rows.length > 0 && <p className="border-t border-slate-100 p-4 text-xs text-slate-500">Cost and margin are shown only to people allowed to see them for every branch in the report.</p>}
      </Card>
    </>
  )
}
