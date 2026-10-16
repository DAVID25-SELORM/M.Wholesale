import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, PageHeader, Select } from '@/components/ui'
import { downloadCsv } from '@/lib/download'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import { getAccountLedger, listAccounts } from '@/services/accounting'
import { moneyFmt } from '@/services/sales'

const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
const monthStart = () => { const d = new Date(); d.setDate(1); return iso(d) }

export function LedgerPage() {
  const { branches } = useSession()
  const [params, setParams] = useSearchParams()
  const accountId = params.get('account') ?? ''
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(iso(new Date()))
  const [branchId, setBranchId] = useState('')
  const accounts = useQuery({ queryKey: ['gl-accounts'], queryFn: listAccounts, staleTime: 60_000 })
  const valid = accountId !== '' && from !== '' && to !== '' && from <= to
  const ledger = useQuery({ queryKey: ['account-ledger', accountId, from, to, branchId], queryFn: () => getAccountLedger(accountId, from, to, branchId || null), enabled: valid })
  const account = (accounts.data ?? []).find((a) => a.id === accountId)
  const rows = ledger.data ?? []
  const csv = () => downloadCsv(`ledger-${account?.code ?? 'account'}-${from}-to-${to}`, [['Date', 'Journal', 'Description', 'Memo', 'Debit', 'Credit', 'Balance (Dr positive)'],
    ...rows.map((r) => [r.journal_date, r.journal_number ?? '', r.description, r.memo ?? '', r.debit ? moneyFmt(r.debit) : '', r.credit ? moneyFmt(r.credit) : '', moneyFmt(r.running)])])

  return (
    <>
      <PageHeader title="Account ledger" description="Every posting to one account with a running balance (debit positive)." />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:flex-wrap sm:items-end">
          <Field label="Account" className="sm:w-72"><Select value={accountId} onChange={(e) => setParams(e.target.value ? { account: e.target.value } : {})}><option value="">Choose an account…</option>{(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
          <Field label="From"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
          {branches.length > 1 && <Field label="Branch"><Select value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">All my branches</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>}
          <Button variant="secondary" className="sm:ml-auto" onClick={csv} disabled={rows.length === 0}><Download className="h-4 w-4" aria-hidden /> CSV</Button>
        </div>
        {!accountId ? <EmptyState title="Choose an account" description="Pick an account above, or open it from the chart of accounts or a statement." />
          : !valid ? <p className="p-4 text-sm text-amber-800">Choose a start date that is not after the end date.</p>
          : ledger.isPending ? <LoadingState />
          : ledger.isError ? <ErrorState message={toAppError(ledger.error).message} onRetry={() => void ledger.refetch()} />
          : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <caption className="sr-only">Ledger of {account?.name}</caption>
                <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2">Date</th><th className="px-4">Journal</th><th className="px-4">Description</th><th className="px-4 text-right">Debit</th><th className="px-4 text-right">Credit</th><th className="px-4 text-right">Balance</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r, i) => (
                    <tr key={r.line_id ?? `open-${i}`} className={r.line_id ? '' : 'bg-slate-50 font-medium'}>
                      <td className="whitespace-nowrap px-4 py-2 text-slate-600">{r.journal_date}</td><td className="px-4 font-mono text-xs">{r.journal_number ?? ''}</td>
                      <td className="px-4">{r.description}{r.memo ? <span className="text-slate-500"> · {r.memo}</span> : null}</td>
                      <td className="px-4 text-right tabular-nums">{r.debit ? moneyFmt(r.debit) : ''}</td><td className="px-4 text-right tabular-nums">{r.credit ? moneyFmt(r.credit) : ''}</td>
                      <td className="px-4 text-right font-medium tabular-nums">{moneyFmt(r.running)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length >= 2000 && <p className="p-3 text-xs text-amber-800">Showing the first 2,000 postings. Narrow the dates to see the rest.</p>}
            </div>
          )}
      </Card>
    </>
  )
}
