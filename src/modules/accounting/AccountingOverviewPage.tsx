import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Lock } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, CardBody, CardHeader, ErrorState, Field, InlineError, Input, LoadingState, Modal, PageHeader, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import {
  getAccountingChecks, getAccountingSettings, listAccounts, setPeriodLock, startAccounting, suggestOpeningBalances, type GlAccount,
} from '@/services/accounting'
import { moneyFmt, round2 } from '@/services/sales'

const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
const KEYS_TO_ASK = ['CASH', 'BANK', 'MOBILE_MONEY', 'CARD_CLEARING', 'VAT_INPUT', 'VAT_OUTPUT'] as const
const ACCOUNTING_QUERIES = ['accounting-settings', 'accounting-checks', 'gl-accounts', 'journals', 'trial-balance', 'income-statement', 'balance-sheet', 'account-ledger', 'bank-accounts']

export function AccountingOverviewPage() {
  const { ability } = useSession()
  const canManage = ability.can('accounting.manage')
  const settings = useQuery({ queryKey: ['accounting-settings'], queryFn: getAccountingSettings })
  if (settings.isPending) return <LoadingState />
  if (settings.isError) return <ErrorState message={toAppError(settings.error).message} onRetry={() => void settings.refetch()} />
  return (
    <>
      <PageHeader title="Accounting" description="The books: a double-entry ledger fed automatically by sales, receipts, refunds, stock and supplier invoices, plus manual journals, financial statements and bank reconciliation." />
      {settings.data ? <Running goLive={settings.data.go_live_date} lockedThrough={settings.data.locked_through} canManage={canManage} /> : canManage ? <StartCard /> : (
        <Card><CardBody><p className="text-sm text-slate-700">Accounting has not been started yet. The owner or accounts manager starts it by choosing a go-live date and entering the opening balances.</p></CardBody></Card>
      )}
    </>
  )
}

// ---- starting -----------------------------------------------------------------------------------------------------------
function StartCard() {
  const qc = useQueryClient()
  const toast = useToast()
  const accounts = useQuery({ queryKey: ['gl-accounts'], queryFn: listAccounts })
  const suggestions = useQuery({ queryKey: ['opening-suggestions'], queryFn: suggestOpeningBalances })
  const [goLive, setGoLive] = useState(iso(new Date()))
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const asked = (accounts.data ?? []).filter((a) => a.system_key && (KEYS_TO_ASK as readonly string[]).includes(a.system_key))
  const suggested = suggestions.data ?? []
  const suggestedValue = new Map(suggested.map((x) => [x.account_id, String(round2(x.suggested))]))
  const val = (id: string) => values[id] ?? suggestedValue.get(id) ?? ''

  const start = useMutation({
    mutationFn: () => {
      const lines = [...suggested.map((s) => s.account_id), ...asked.map((a) => a.id)].map((id) => {
        const acc = (accounts.data ?? []).find((a) => a.id === id)
        const v = Number(val(id) || 0)
        const creditNormal = acc?.normal_side === 'CREDIT'
        return { account_id: id, debit: !creditNormal && v > 0 ? v : creditNormal && v < 0 ? -v : 0, credit: creditNormal && v > 0 ? v : !creditNormal && v < 0 ? -v : 0 }
      }).filter((l) => l.debit > 0 || l.credit > 0)
      return startAccounting(goLive, lines)
    },
    onSuccess: async () => {
      toast.success('Accounting started. Documents from the go-live date now post to the ledger automatically.')
      await Promise.all(ACCOUNTING_QUERIES.map((k) => qc.invalidateQueries({ queryKey: [k] })))
    },
    onError: (e) => setError(toAppError(e).message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    for (const v of [...suggested.map((x) => val(x.account_id)), ...asked.map((x) => val(x.id))]) if (v.trim() !== '' && (!Number.isFinite(Number(v)) || Math.abs(round2(Number(v)) - Number(v)) > 1e-9)) { setError('Opening balances are amounts with at most 2 decimals.'); return }
    if (!goLive) { setError('Choose the go-live date.'); return }
    setError(null)
    start.mutate()
  }

  const row = (a: GlAccount, basis?: string) => (
    <div key={a.id} className="grid items-center gap-2 sm:grid-cols-[1fr_12rem]">
      <div><div className="text-sm font-medium text-slate-900">{a.code} · {a.name}</div>{basis && <div className="text-xs text-slate-500">{basis}</div>}</div>
      <Input aria-label={`Opening balance for ${a.name}`} type="number" inputMode="decimal" step="0.01" value={val(a.id)} onChange={(e) => setValues((v) => ({ ...v, [a.id]: e.target.value }))} placeholder="0.00" />
    </div>
  )
  const byId = new Map((accounts.data ?? []).map((a) => [a.id, a]))

  return (
    <Card>
      <CardHeader title="Start accounting" description="Do this once. From the go-live date every sale, receipt, refund, stock movement and supplier invoice is journalled automatically; earlier documents are carried by the opening balances." />
      <CardBody>
        {accounts.isPending || suggestions.isPending ? <LoadingState /> : accounts.isError || suggestions.isError ? <ErrorState message={toAppError(accounts.error ?? suggestions.error).message} /> : (
          <form onSubmit={submit} noValidate className="space-y-4">
            <InlineError message={error} />
            <Field label="Go-live date" required hint="Documents dated before this day are not journalled. Enter any back-dated documents first."><Input type="date" value={goLive} onChange={(e) => setGoLive(e.target.value)} className="sm:max-w-xs" /></Field>
            <div>
              <h3 className="mb-2 text-sm font-semibold text-slate-900">Balances from your records (check them)</h3>
              <div className="space-y-3">{suggested.map((s) => byId.get(s.account_id) && row(byId.get(s.account_id)!, s.basis))}</div>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold text-slate-900">Balances you know from the real world</h3>
              <p className="mb-2 text-xs text-slate-500">Cash counted, bank and mobile-money balances today, VAT owed or recoverable. Leave blank what is nil. Capital and other equity is worked out automatically as the balancing figure.</p>
              <div className="space-y-3">{asked.map((a) => row(a))}</div>
            </div>
            <div className="flex justify-end"><Button type="submit" loading={start.isPending}>Start accounting</Button></div>
          </form>
        )}
      </CardBody>
    </Card>
  )
}

// ---- running ------------------------------------------------------------------------------------------------------------
function Running({ goLive, lockedThrough, canManage }: { goLive: string; lockedThrough: string | null; canManage: boolean }) {
  const checks = useQuery({ queryKey: ['accounting-checks'], queryFn: getAccountingChecks })
  const [locking, setLocking] = useState(false)
  const allGood = (checks.data ?? []).every((c) => Math.abs(c.difference) < 0.005)
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card><CardBody><div className="text-xs uppercase tracking-wide text-slate-500">Go-live date</div><div className="mt-1 text-lg font-semibold text-slate-900">{goLive}</div></CardBody></Card>
        <Card><CardBody>
          <div className="text-xs uppercase tracking-wide text-slate-500">Books closed through</div>
          <div className="mt-1 flex items-center gap-2 text-lg font-semibold text-slate-900">{lockedThrough ? <><Lock className="h-4 w-4 text-slate-500" aria-hidden />{lockedThrough}</> : <span className="text-slate-500">Not closed</span>}</div>
          {canManage && <Button size="sm" variant="secondary" className="mt-2" onClick={() => setLocking(true)}>Close a period</Button>}
        </CardBody></Card>
        <Card><CardBody>
          <div className="text-xs uppercase tracking-wide text-slate-500">Control checks</div>
          <div className="mt-1">{checks.isPending ? <span className="text-sm text-slate-500">Checking…</span> : allGood ? <Badge tone="green">All agree</Badge> : <Badge tone="red">Differences found</Badge>}</div>
        </CardBody></Card>
      </div>

      <Card>
        <CardHeader title="Control checks" description="The ledger against the customer, stock and supplier records. A difference means something was entered outside the documents, or an opening balance was wrong." />
        {checks.isPending ? <LoadingState /> : checks.isError ? <ErrorState message={toAppError(checks.error).message} onRetry={() => void checks.refetch()} /> : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">Control checks</caption>
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2">Check</th><th className="px-4 text-right">Ledger</th><th className="px-4 text-right">Records</th><th className="px-4 text-right">Difference</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {(checks.data ?? []).map((c) => {
                  const bad = Math.abs(c.difference) >= 0.005
                  return (
                    <tr key={c.check_code}>
                      <td className="px-4 py-2"><span className="inline-flex items-center gap-2">{bad ? <AlertTriangle className="h-4 w-4 text-red-600" aria-hidden /> : <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />}{c.label}</span></td>
                      <td className="px-4 text-right tabular-nums">{moneyFmt(c.ledger)}</td><td className="px-4 text-right tabular-nums">{moneyFmt(c.operational)}</td>
                      <td className={`px-4 text-right font-semibold tabular-nums ${bad ? 'text-red-700' : 'text-slate-500'}`}>{moneyFmt(c.difference)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardBody>
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {([['/accounting/journals', 'Journals', 'Every entry in the books; post or reverse manual journals'], ['/accounting/statements', 'Financial statements', 'Trial balance, profit and loss, balance sheet'],
              ['/accounting/accounts', 'Chart of accounts', 'The accounts the books are kept in'], ['/accounting/bank', 'Bank reconciliation', 'Import statements and match them to the books']] as const).map(([to, t, d]) => (
              <li key={to}><Link to={to} className="block rounded-md border border-slate-200 p-3 hover:bg-slate-50"><span className="font-medium text-slate-900">{t}</span><span className="block text-xs text-slate-500">{d}</span></Link></li>
            ))}
          </ul>
        </CardBody>
      </Card>
      {locking && <LockDialog current={lockedThrough} goLive={goLive} onClose={() => setLocking(false)} />}
    </div>
  )
}

function LockDialog({ current, goLive, onClose }: { current: string | null; goLive: string; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [through, setThrough] = useState(current ?? goLive)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const backwards = current !== null && through < current
  const lock = useMutation({
    mutationFn: () => setPeriodLock(through, reason),
    onSuccess: async () => { toast.success(`Books closed through ${through}.`); await Promise.all(ACCOUNTING_QUERIES.map((k) => qc.invalidateQueries({ queryKey: [k] }))); onClose() },
    onError: (e) => setError(toAppError(e).message),
  })
  return (
    <Modal open size="md" onClose={onClose} title="Close a period" description="Nothing can be journalled on or before the closing date: manual journals are refused, and a document dated inside it is journalled on the first open day instead, so closed figures never change."
      footer={<><Button variant="secondary" onClick={onClose} disabled={lock.isPending}>Back</Button><Button loading={lock.isPending} onClick={() => { if (backwards && reason.trim().length < 5) { setError('Give a reason for reopening a closed period.'); return } setError(null); lock.mutate() }}>Close through this date</Button></>}>
      <div className="space-y-3">
        <InlineError message={error} />
        <Field label="Closed through" required><Input type="date" min={goLive} max={iso(new Date())} value={through} onChange={(e) => setThrough(e.target.value)} /></Field>
        {backwards && <Field label="Reason for reopening" required><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>}
      </div>
    </Modal>
  )
}
