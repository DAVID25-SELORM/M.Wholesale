import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CheckCircle2, Lock } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, InlineError, Input, LoadingState, Modal, PageHeader, Select, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import {
  autoMatch, clearLedgerLines, finalizeReconciliation, getBankLedgerLines, getReconciliation, getStatement, getStatementLines, listAccounts, listBankAccounts,
  matchLine, postBankEntry, suggestMatches, unmatchLine, type StatementLine,
} from '@/services/accounting'
import { moneyFmt, round2 } from '@/services/sales'

const KEYS = ['statement-lines', 'bank-reconciliation', 'bank-suggestions', 'bank-ledger', 'bank-statement', 'bank-statements', 'journals', 'accounting-checks', 'trial-balance', 'account-ledger']

export function ReconcilePage() {
  const { id = '' } = useParams()
  const { ability } = useSession()
  const canWork = ability.can('bank.reconcile')
  const qc = useQueryClient()
  const toast = useToast()
  const statement = useQuery({ queryKey: ['bank-statement', id], queryFn: () => getStatement(id) })
  const accounts = useQuery({ queryKey: ['bank-accounts'], queryFn: listBankAccounts })
  const lines = useQuery({ queryKey: ['statement-lines', id], queryFn: () => getStatementLines(id) })
  const rec = useQuery({ queryKey: ['bank-reconciliation', id], queryFn: () => getReconciliation(id) })
  const open = statement.data?.status === 'OPEN'
  const suggestions = useQuery({ queryKey: ['bank-suggestions', id], queryFn: () => suggestMatches(id), enabled: open && canWork })
  const ledger = useQuery({ queryKey: ['bank-ledger', statement.data?.bank_account_id], queryFn: () => getBankLedgerLines(statement.data!.bank_account_id, true), enabled: Boolean(statement.data) && open })

  const [selected, setSelected] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [booking, setBooking] = useState<StatementLine | null>(null)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = () => Promise.all(KEYS.map((k) => qc.invalidateQueries({ queryKey: [k] })))
  const fail = (e: unknown) => setError(toAppError(e).message)

  const auto = useMutation({ mutationFn: () => autoMatch(id), onSuccess: async (n) => { toast.success(n === 0 ? 'No unambiguous matches found.' : `${n} line(s) matched.`); setError(null); await refresh() }, onError: fail })
  const match = useMutation({ mutationFn: (v: { line: string; ledger: string[] }) => matchLine(v.line, v.ledger), onSuccess: async () => { setSelected(null); setPicked(new Set()); setError(null); await refresh() }, onError: fail })
  const unmatch = useMutation({ mutationFn: (line: string) => unmatchLine(line), onSuccess: async () => { setError(null); await refresh() }, onError: fail })
  const finish = useMutation({ mutationFn: () => finalizeReconciliation(id), onSuccess: async () => { toast.success('Reconciliation finished. The statement is now locked.'); setError(null); await refresh() }, onError: fail })

  const sel = (lines.data ?? []).find((l) => l.id === selected) ?? null
  const pickedSum = round2((ledger.data ?? []).filter((l) => picked.has(l.journal_line_id)).reduce((s, l) => s + l.amount, 0))
  const suggestionRows = suggestions.data
  const best = useMemo(() => {
    const m = new Map<string, NonNullable<typeof suggestionRows>[number]>()
    for (const s of suggestionRows ?? []) if (!m.has(s.statement_line_id)) m.set(s.statement_line_id, s)
    return m
  }, [suggestionRows])
  const recMap = Object.fromEntries((rec.data ?? []).map((r) => [r.item, r.amount]))
  const ready = open && canWork && recMap.DIFFERENCE === 0 && recMap.UNMATCHED_LINES === 0

  if (statement.isPending || lines.isPending) return <LoadingState />
  if (statement.isError || !statement.data) return <ErrorState message={statement.isError ? toAppError(statement.error).message : 'Statement not found.'} />
  const st = statement.data
  const bankName = (accounts.data ?? []).find((a) => a.id === st.bank_account_id)?.name ?? 'Bank account'

  return (
    <>
      <PageHeader title={`${bankName}: ${st.period_from} to ${st.period_to}`} description={`Opening ${moneyFmt(st.opening_balance)} · closing ${moneyFmt(st.closing_balance)}${st.file_name ? ` · ${st.file_name}` : ''}`}
        actions={<><Link to="/accounting/bank" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:underline"><ArrowLeft className="h-4 w-4" aria-hidden /> All statements</Link>
          {st.status === 'RECONCILED' ? <Badge tone="green"><Lock className="mr-1 h-3 w-3" aria-hidden /> Reconciled and locked</Badge> : canWork && <><Button variant="secondary" loading={auto.isPending} onClick={() => auto.mutate()}>Match automatically</Button><Button disabled={!ready} loading={finish.isPending} onClick={() => finish.mutate()}>Finish reconciliation</Button></>}</>} />
      <InlineError message={error} />
      <div className="mt-3 grid gap-4 xl:grid-cols-[22rem_1fr]">
        <Card className="h-fit">
          <CardHeader title="Reconciliation" description="Both adjusted balances must agree." />
          {rec.isPending ? <LoadingState /> : rec.isError ? <ErrorState message={toAppError(rec.error).message} /> : (
            <dl className="divide-y divide-slate-100 text-sm">
              {(rec.data ?? []).filter((r) => r.item !== 'UNMATCHED_LINES').map((r) => {
                const strong = r.item.startsWith('ADJUSTED') || r.item === 'DIFFERENCE'
                return <div key={r.item} className={`flex items-start justify-between gap-3 px-4 py-2 ${strong ? 'bg-slate-50 font-semibold' : ''}`}><dt className="text-slate-700">{r.label}</dt><dd className={`tabular-nums ${r.item === 'DIFFERENCE' && r.amount !== 0 ? 'text-red-700' : ''}`}>{moneyFmt(r.amount)}</dd></div>
              })}
              <div className="flex items-center justify-between px-4 py-2 text-slate-700"><dt>Lines still unmatched</dt><dd className="tabular-nums">{recMap.UNMATCHED_LINES ?? 0}</dd></div>
              {recMap.DIFFERENCE === 0 && recMap.UNMATCHED_LINES === 0 && <div className="flex items-center gap-2 px-4 py-2 text-emerald-700"><CheckCircle2 className="h-4 w-4" aria-hidden /> Balanced: ready to finish.</div>}
            </dl>
          )}
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Statement lines" description={open && canWork ? 'Accept a suggestion, or choose a line and tick the matching entries below. A line with no entry in the books (charges, interest) is booked here.' : undefined} />
            {(lines.data ?? []).length === 0 ? <EmptyState title="No lines" /> : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <caption className="sr-only">Statement lines</caption>
                  <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500"><tr>{open && canWork && <th className="w-8 px-3 py-2"><span className="sr-only">Select</span></th>}<th className="px-3 py-2">Date</th><th className="px-3">Details</th><th className="px-3 text-right">Amount</th><th className="px-3">Status</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {(lines.data ?? []).map((l) => {
                      const s = best.get(l.id)
                      return (
                        <tr key={l.id} className={selected === l.id ? 'bg-brand-50' : ''}>
                          {open && canWork && <td className="px-3 py-2"><input type="radio" name="line" aria-label={`Select line ${l.line_no}`} disabled={l.matched} checked={selected === l.id} onChange={() => { setSelected(l.id); setPicked(new Set()) }} /></td>}
                          <td className="whitespace-nowrap px-3 py-2 text-slate-600">{l.txn_date}</td>
                          <td className="px-3 py-2"><div className="text-slate-900">{l.description || '—'}</div>{l.reference && <div className="font-mono text-xs text-slate-500">{l.reference}</div>}</td>
                          <td className={`px-3 text-right tabular-nums ${l.amount < 0 ? 'text-red-700' : ''}`}>{moneyFmt(l.amount)}</td>
                          <td className="px-3 py-2">
                            {l.matched ? <span className="inline-flex items-center gap-2"><Badge tone="green">Matched</Badge>{open && canWork && <Button size="sm" variant="ghost" loading={unmatch.isPending && unmatch.variables === l.id} onClick={() => unmatch.mutate(l.id)}>Undo</Button>}</span> : (
                              <span className="inline-flex flex-wrap items-center gap-2"><Badge tone="amber">Unmatched</Badge>
                                {open && canWork && s && <Button size="sm" variant="secondary" title={`${s.journal_number} · ${s.journal_date} · ${s.description}`} loading={match.isPending && match.variables?.line === l.id} onClick={() => match.mutate({ line: l.id, ledger: [s.journal_line_id] })}>Accept {s.journal_number}</Button>}
                                {open && canWork && <Button size="sm" variant="ghost" onClick={() => setBooking(l)}>Book entry…</Button>}
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {open && (
            <Card>
              <CardHeader title="Entries in the books not yet on a statement" description="Receipts and payments the books show for this account that no statement line has matched."
                actions={canWork ? <Button size="sm" variant="ghost" disabled={picked.size === 0} onClick={() => setClearing(true)}>Clear without a statement…</Button> : undefined} />
              {ledger.isPending ? <LoadingState /> : ledger.isError ? <ErrorState message={toAppError(ledger.error).message} /> : (ledger.data ?? []).length === 0 ? <EmptyState title="Nothing waiting" description="Every entry for this account is matched or cleared." /> : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <caption className="sr-only">Unmatched ledger entries</caption>
                    <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500"><tr>{canWork && <th className="w-8 px-3 py-2"><span className="sr-only">Tick</span></th>}<th className="px-3 py-2">Date</th><th className="px-3">Journal</th><th className="px-3">Description</th><th className="px-3 text-right">Amount</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {(ledger.data ?? []).map((l) => (
                        <tr key={l.journal_line_id}>
                          {canWork && <td className="px-3 py-2"><input type="checkbox" aria-label={`Tick ${l.journal_number}`} checked={picked.has(l.journal_line_id)} onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(l.journal_line_id); else n.delete(l.journal_line_id); return n })} /></td>}
                          <td className="whitespace-nowrap px-3 py-2 text-slate-600">{l.journal_date}</td><td className="px-3 font-mono text-xs">{l.journal_number}</td><td className="px-3">{l.description}{l.memo ? <span className="text-slate-500"> · {l.memo}</span> : null}</td>
                          <td className={`px-3 text-right tabular-nums ${l.amount < 0 ? 'text-red-700' : ''}`}>{moneyFmt(l.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {canWork && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm">
                  <span className="text-slate-600">{sel ? <>Statement line {moneyFmt(sel.amount)}; ticked entries {moneyFmt(pickedSum)}{picked.size > 0 && round2(pickedSum - sel.amount) !== 0 ? ` (off by ${moneyFmt(round2(pickedSum - sel.amount))})` : ''}</> : 'Choose a statement line above, then tick the entries that make up its amount.'}</span>
                  <Button disabled={!sel || picked.size === 0 || round2(pickedSum - sel.amount) !== 0} loading={match.isPending} onClick={() => sel && match.mutate({ line: sel.id, ledger: [...picked] })}>Match selected</Button>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
      {booking && <BookEntryDialog line={booking} onClose={() => setBooking(null)} onDone={async () => { setBooking(null); setError(null); await refresh() }} />}
      {clearing && <ClearDialog bankAccountId={st.bank_account_id} ids={[...picked]} onClose={() => setClearing(false)} onDone={async () => { setClearing(false); setPicked(new Set()); await refresh() }} />}
    </>
  )
}

function BookEntryDialog({ line, onClose, onDone }: { line: StatementLine; onClose: () => void; onDone: () => Promise<void> }) {
  const toast = useToast()
  const accounts = useQuery({ queryKey: ['gl-accounts'], queryFn: listAccounts })
  const usable = (accounts.data ?? []).filter((a) => a.is_active && a.allow_manual && a.system_key !== 'BANK' && a.system_key !== 'MOBILE_MONEY' && a.system_key !== 'CASH')
  const charges = usable.find((a) => a.system_key === 'BANK_CHARGES')
  const [account, setAccount] = useState('')
  const [description, setDescription] = useState(line.description ?? '')
  const [error, setError] = useState<string | null>(null)
  const chosen = account || (line.amount < 0 ? charges?.id ?? '' : '')
  const book = useMutation({ mutationFn: () => postBankEntry(line.id, chosen, description), onSuccess: async () => { toast.success('Entry booked and matched.'); await onDone() }, onError: (e) => setError(toAppError(e).message) })
  return (
    <Modal open size="md" onClose={onClose} title="Book this line" description={`${line.txn_date} · ${moneyFmt(line.amount)}. ${line.amount < 0 ? 'Money out: the account you choose is debited (an expense or asset).' : 'Money in: the account you choose is credited (income or a liability).'}`}
      footer={<><Button variant="secondary" onClick={onClose} disabled={book.isPending}>Back</Button><Button loading={book.isPending} onClick={() => { if (!chosen) { setError('Choose the account to book it against.'); return } setError(null); book.mutate() }}>Book and match</Button></>}>
      <div className="space-y-3">
        <InlineError message={error} />
        <Field label="Book against" required><Select value={chosen} onChange={(e) => setAccount(e.target.value)}><option value="">Choose account…</option>{usable.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
        <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></Field>
      </div>
    </Modal>
  )
}

function ClearDialog({ bankAccountId, ids, onClose, onDone }: { bankAccountId: string; ids: string[]; onClose: () => void; onDone: () => Promise<void> }) {
  const toast = useToast()
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const clear = useMutation({ mutationFn: () => clearLedgerLines(bankAccountId, ids, note), onSuccess: async (n) => { toast.success(`${n} entr${n === 1 ? 'y' : 'ies'} cleared.`); await onDone() }, onError: (e) => setError(toAppError(e).message) })
  return (
    <Modal open size="md" onClose={onClose} title="Clear without a statement line" description="For entries that will never appear on a statement (a reversed entry, an opening difference). The reason is kept with them."
      footer={<><Button variant="secondary" onClick={onClose} disabled={clear.isPending}>Back</Button><Button loading={clear.isPending} onClick={() => { if (note.trim().length < 5) { setError('Give a reason.'); return } setError(null); clear.mutate() }}>Clear {ids.length}</Button></>}>
      <div className="space-y-3"><InlineError message={error} /><Field label="Reason" required><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} autoFocus /></Field></div>
    </Modal>
  )
}
