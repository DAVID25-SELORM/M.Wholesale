import { useQuery } from '@tanstack/react-query'
import { Download, FileDown } from 'lucide-react'
import { useState } from 'react'
import { Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, PageHeader, Select, useToast } from '@/components/ui'
import { downloadCsv } from '@/lib/download'
import { toAppError } from '@/lib/errors'
import { downloadTablePdf } from '@/lib/pdf'
import { useSession } from '@/modules/session/SessionProvider'
import { getVatReport } from '@/services/insights'
import { moneyFmt, round2 } from '@/services/sales'

const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
const monthStart = () => { const d = new Date(); d.setDate(1); return iso(d) }

export function VatReportPage() {
  const { branches, context } = useSession()
  const toast = useToast()
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(iso(new Date()))
  const [branchId, setBranchId] = useState('')
  const valid = from !== '' && to !== '' && from <= to
  const query = useQuery({ queryKey: ['vat-report', from, to, branchId], queryFn: () => getVatReport(from, to, branchId || null), enabled: valid })
  const rows = query.data ?? []
  const out = rows.filter((r) => r.section === 'OUTPUT')
  const inn = rows.filter((r) => r.section === 'INPUT')
  const outTax = round2(out.reduce((s, r) => s + r.tax, 0))
  const outBase = round2(out.reduce((s, r) => s + r.taxable, 0))
  const inTax = round2(inn.reduce((s, r) => s + r.tax, 0))
  const payable = round2(outTax - inTax)
  const lines: string[][] = [
    ...out.map((r) => ['Output (sales)', r.tax_name + (r.rate !== null ? ` ${r.rate}%` : ''), moneyFmt(r.taxable), moneyFmt(r.tax)]),
    ['Output (sales)', 'Total output VAT', moneyFmt(outBase), moneyFmt(outTax)],
    ...inn.map((r) => ['Input (purchases)', r.tax_name, moneyFmt(r.taxable), moneyFmt(r.tax)]),
    ['', payable >= 0 ? 'VAT payable (output less input)' : 'VAT refundable (input exceeds output)', '', moneyFmt(Math.abs(payable))],
  ]

  async function pdf() {
    try {
      await downloadTablePdf({ title: 'VAT summary', subtitle: `${from} to ${to}${branchId ? ` · ${branches.find((b) => b.id === branchId)?.name ?? ''}` : ''}`, organization: context.organization?.name ?? '', filename: `vat-summary-${from}-to-${to}`,
        columns: [{ header: 'Section' }, { header: 'Tax' }, { header: 'Taxable amount', align: 'right' }, { header: 'VAT', align: 'right' }], rows: lines })
    } catch (e) { toast.error(toAppError(e).message) }
  }

  return (
    <>
      <PageHeader title="VAT summary" description="Output VAT on posted invoices (net of credit notes) and input VAT on approved supplier invoices. A working summary for your VAT return: it is not connected to the tax authority." />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:flex-wrap sm:items-end">
          <Field label="From"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
          {branches.length > 1 && <Field label="Branch"><Select value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">All my branches</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>}
          <div className="flex gap-2 sm:ml-auto">
            <Button variant="secondary" onClick={() => downloadCsv(`vat-summary-${from}-to-${to}`, [['Section', 'Tax', 'Taxable amount', 'VAT'], ...lines])} disabled={rows.length === 0}><Download className="h-4 w-4" aria-hidden /> CSV</Button>
            <Button variant="secondary" onClick={() => void pdf()} disabled={rows.length === 0}><FileDown className="h-4 w-4" aria-hidden /> PDF</Button>
          </div>
        </div>
        {!valid ? <p className="p-4 text-sm text-amber-800">Choose a start date that is not after the end date.</p>
          : query.isPending ? <LoadingState />
          : query.isError ? <ErrorState message={toAppError(query.error).message} onRetry={() => void query.refetch()} />
          : rows.length === 0 ? <EmptyState title="No VAT activity in this period" />
          : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <caption className="sr-only">VAT summary</caption>
                <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2">Section</th><th className="px-4">Tax</th><th className="px-4 text-right">Taxable amount</th><th className="px-4 text-right">VAT</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {lines.map((l, i) => {
                    const total = l[1]?.startsWith('Total') || l[1]?.startsWith('VAT ')
                    return <tr key={i} className={total ? 'bg-slate-50 font-semibold' : ''}>{l.map((c, j) => <td key={j} className={`px-4 py-2 ${j >= 2 ? 'text-right tabular-nums' : ''} ${j === 3 && l[1]?.startsWith('VAT payable') ? 'text-red-700' : ''}`}>{c}</td>)}</tr>
                  })}
                </tbody>
              </table>
            </div>
          )}
      </Card>
    </>
  )
}
