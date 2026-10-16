import { useQuery } from '@tanstack/react-query'
import { Download, FileDown } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, PageHeader, Select, Tabs, useToast } from '@/components/ui'
import { downloadCsv } from '@/lib/download'
import { toAppError } from '@/lib/errors'
import { downloadTablePdf } from '@/lib/pdf'
import { useSession } from '@/modules/session/SessionProvider'
import { getBalanceSheet, getIncomeStatement, getTrialBalance } from '@/services/accounting'
import { moneyFmt, round2 } from '@/services/sales'

const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
const monthStart = () => { const d = new Date(); d.setDate(1); return iso(d) }
type Tab = 'trial' | 'income' | 'balance'
type Cell = string
const th = 'px-4 py-2'
const money = (n: number) => (Math.abs(n) < 0.005 ? '' : moneyFmt(n))

export function StatementsPage() {
  const { branches, context } = useSession()
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('trial')
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(iso(new Date()))
  const [branchId, setBranchId] = useState('')
  const valid = from !== '' && to !== '' && from <= to
  const trial = useQuery({ queryKey: ['trial-balance', from, to, branchId], queryFn: () => getTrialBalance(from, to, branchId || null), enabled: valid && tab === 'trial' })
  const income = useQuery({ queryKey: ['income-statement', from, to, branchId], queryFn: () => getIncomeStatement(from, to, branchId || null), enabled: valid && tab === 'income' })
  const balance = useQuery({ queryKey: ['balance-sheet', to, branchId], queryFn: () => getBalanceSheet(to, branchId || null), enabled: to !== '' && tab === 'balance' })
  const active = tab === 'trial' ? trial : tab === 'income' ? income : balance
  const branchName = branchId ? branches.find((b) => b.id === branchId)?.name ?? '' : ''

  // ---- the three statements as plain tables of text (the same rows feed the screen, the CSV and the PDF)
  const table = ((): { title: string; headers: string[]; rows: Cell[][]; strong: Set<number>; links: Map<number, string> } => {
    const strong = new Set<number>()
    const links = new Map<number, string>()
    if (tab === 'trial') {
      const rows = (trial.data ?? []).filter((r) => r.opening !== 0 || r.period_debit !== 0 || r.period_credit !== 0 || r.closing !== 0)
      const out: Cell[][] = rows.map((r, i) => { links.set(i, r.account_id); return [r.code, r.name, money(Math.max(r.opening, 0)), money(Math.max(-r.opening, 0)), money(r.period_debit), money(r.period_credit), money(Math.max(r.closing, 0)), money(Math.max(-r.closing, 0))] })
      const sum = (f: (r: (typeof rows)[number]) => number) => moneyFmt(round2(rows.reduce((s, r) => s + f(r), 0)))
      strong.add(out.length)
      out.push(['', 'Total', sum((r) => Math.max(r.opening, 0)), sum((r) => Math.max(-r.opening, 0)), sum((r) => r.period_debit), sum((r) => r.period_credit), sum((r) => Math.max(r.closing, 0)), sum((r) => Math.max(-r.closing, 0))])
      return { title: 'Trial balance', headers: ['Code', 'Account', 'Opening Dr', 'Opening Cr', 'Debits', 'Credits', 'Closing Dr', 'Closing Cr'], rows: rows.length ? out : [], strong, links }
    }
    if (tab === 'income') {
      const rows = (income.data ?? []).filter((r) => r.amount !== 0)
      const rev = rows.filter((r) => r.account_type === 'REVENUE'); const exp = rows.filter((r) => r.account_type === 'EXPENSE')
      const tr = round2(rev.reduce((s, r) => s + r.amount, 0)); const te = round2(exp.reduce((s, r) => s + r.amount, 0))
      const out: Cell[][] = []
      const section = (label: string, list: typeof rows, total: number, totalLabel: string) => {
        strong.add(out.length); out.push(['', label, ''])
        for (const r of list) { links.set(out.length, r.account_id); out.push([r.code, r.name, moneyFmt(r.amount)]) }
        strong.add(out.length); out.push(['', totalLabel, moneyFmt(total)])
      }
      section('Revenue', rev, tr, 'Total revenue'); section('Expenses', exp, te, 'Total expenses')
      strong.add(out.length); out.push(['', round2(tr - te) >= 0 ? 'Net profit' : 'Net loss', moneyFmt(round2(tr - te))])
      return { title: 'Profit and loss', headers: ['Code', 'Account', 'Amount'], rows: rows.length ? out : [], strong, links }
    }
    const rows = (balance.data ?? []).filter((r) => r.amount !== 0 || r.account_id === null)
    const out: Cell[][] = []
    const section = (key: 'ASSET' | 'LIABILITY' | 'EQUITY', label: string) => {
      const list = rows.filter((r) => r.section === key)
      strong.add(out.length); out.push(['', label, ''])
      for (const r of list) { if (r.account_id) links.set(out.length, r.account_id); out.push([r.code, r.name, moneyFmt(r.amount)]) }
      const total = round2(list.reduce((s, r) => s + r.amount, 0))
      strong.add(out.length); out.push(['', `Total ${label.toLowerCase()}`, moneyFmt(total)])
      return total
    }
    const assets = section('ASSET', 'Assets'); const liab = section('LIABILITY', 'Liabilities'); const eq = section('EQUITY', 'Equity')
    strong.add(out.length); out.push(['', 'Liabilities plus equity', moneyFmt(round2(liab + eq))])
    if (Math.abs(assets - liab - eq) >= 0.005) out.push(['', 'Out of balance (investigate)', moneyFmt(round2(assets - liab - eq))])
    return { title: 'Balance sheet', headers: ['Code', 'Account', 'Amount'], rows: (balance.data ?? []).length ? out : [], strong, links }
  })()

  const period = tab === 'balance' ? `as at ${to}` : `${from} to ${to}`
  const subtitle = `${period}${branchName ? ` · ${branchName}` : ''}`
  const numeric = (j: number) => (tab === 'trial' ? j >= 2 : j >= 2)

  async function pdf() {
    try {
      await downloadTablePdf({ title: table.title, subtitle, organization: context.organization?.name ?? '', filename: `${table.title.toLowerCase().replace(/\s+/g, '-')}-${tab === 'balance' ? to : `${from}-to-${to}`}`,
        columns: table.headers.map((h, i) => ({ header: h, ...(numeric(i) ? { align: 'right' as const } : {}) })), rows: table.rows })
    } catch (e) { toast.error(toAppError(e).message) }
  }

  return (
    <>
      <PageHeader title="Financial statements" description="Straight from the ledger. A branch-limited accountant sees only their own branch." />
      <Card>
        <div className="space-y-3 border-b border-slate-100 p-4">
          <Tabs label="Statement" value={tab} onChange={(v) => setTab(v as Tab)} items={[{ id: 'trial', label: 'Trial balance' }, { id: 'income', label: 'Profit and loss' }, { id: 'balance', label: 'Balance sheet' }]} />
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
            {tab !== 'balance' && <Field label="From"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>}
            <Field label={tab === 'balance' ? 'As at' : 'To'}><Input type="date" value={to} min={tab === 'balance' ? undefined : from} onChange={(e) => setTo(e.target.value)} /></Field>
            {branches.length > 1 && <Field label="Branch"><Select value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">All my branches</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>}
            <div className="flex gap-2 sm:ml-auto">
              <Button variant="secondary" disabled={table.rows.length === 0} onClick={() => downloadCsv(`${table.title.toLowerCase().replace(/\s+/g, '-')}-${tab === 'balance' ? to : `${from}-to-${to}`}`, [table.headers, ...table.rows])}><Download className="h-4 w-4" aria-hidden /> CSV</Button>
              <Button variant="secondary" disabled={table.rows.length === 0} onClick={() => void pdf()}><FileDown className="h-4 w-4" aria-hidden /> PDF</Button>
            </div>
          </div>
        </div>
        {!valid && tab !== 'balance' ? <p className="p-4 text-sm text-amber-800">Choose a start date that is not after the end date.</p>
          : active.isPending ? <LoadingState />
          : active.isError ? <ErrorState message={toAppError(active.error).message} onRetry={() => void active.refetch()} />
          : table.rows.length === 0 ? <EmptyState title="Nothing in this period" description="There are no postings to show for these dates." />
          : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <caption className="sr-only">{table.title}, {subtitle}</caption>
                <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500"><tr>{table.headers.map((h, i) => <th key={h} className={`${th} ${numeric(i) ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {table.rows.map((r, i) => (
                    <tr key={i} className={table.strong.has(i) ? 'bg-slate-50 font-semibold' : ''}>
                      {r.map((c, j) => (
                        <td key={j} className={`px-4 py-2 ${numeric(j) ? 'text-right tabular-nums' : ''} ${j === 0 ? 'font-mono text-xs' : ''}`}>
                          {j === 1 && table.links.has(i) ? <Link to={`/accounting/ledger?account=${table.links.get(i)}`} className="hover:underline">{c}</Link> : c}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Card>
    </>
  )
}
