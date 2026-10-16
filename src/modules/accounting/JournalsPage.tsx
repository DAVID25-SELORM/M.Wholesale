import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Card, DataTable, Field, InlineError, Input, LoadingState, Modal, PageHeader, Pagination, SearchInput, Select, useToast, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import {
  SOURCE_LABEL, getJournalLines, isJournalReversed, listAccounts, listJournals, postManualJournal, reverseJournal, type JournalRow,
} from '@/services/accounting'
import { moneyFmt, round2 } from '@/services/sales'

const PAGE_SIZE = 25
const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
const REFRESH = ['journals', 'accounting-checks', 'trial-balance', 'income-statement', 'balance-sheet', 'account-ledger']

export function JournalsPage() {
  const { ability } = useSession()
  const canPost = ability.can('journals.create')
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [source, setSource] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [open, setOpen] = useState<JournalRow | null>(null)
  const [creating, setCreating] = useState(false)
  const params = { page, pageSize: PAGE_SIZE, search, source, from, to }
  const query = useQuery({ queryKey: ['journals', params], queryFn: () => listJournals(params), placeholderData: (p) => p })

  const columns: Column<JournalRow>[] = [
    { key: 'no', header: 'Journal', render: (j) => <button type="button" className="font-mono text-xs font-semibold text-slate-900 hover:underline" onClick={() => setOpen(j)}>{j.journal_number}</button> },
    { key: 'date', header: 'Date', render: (j) => <span className="whitespace-nowrap text-slate-600">{j.journal_date}</span> },
    { key: 'desc', header: 'Description', render: (j) => <span className="text-slate-800">{j.description}</span> },
    { key: 'src', header: 'Source', hideOnMobile: true, render: (j) => <Badge tone={j.source_type === 'MANUAL' || j.source_type === 'REVERSAL' ? 'purple' : 'slate'}>{SOURCE_LABEL[j.source_type] ?? j.source_type}</Badge> },
  ]

  return (
    <>
      <PageHeader title="Journals" description="Every entry in the books. Journals from documents are made automatically and cannot be edited; a manual journal is corrected by reversing it."
        actions={canPost ? <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> New journal</Button> : undefined} />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-end">
          <div className="flex-1"><SearchInput value={search} onChange={(v) => { setSearch(v); setPage(0) }} placeholder="Search by journal number or description" label="Search journals" /></div>
          <Field label="Source" className="lg:w-52"><Select value={source} onChange={(e) => { setSource(e.target.value); setPage(0) }}><option value="">All sources</option>{Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="From"><Input type="date" value={from} max={to || undefined} onChange={(e) => { setFrom(e.target.value); setPage(0) }} /></Field>
          <Field label="To"><Input type="date" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); setPage(0) }} /></Field>
        </div>
        <DataTable caption="Journals" columns={columns} rows={query.data?.rows} rowKey={(j) => j.id} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()}
          emptyTitle={search || source || from || to ? 'No journals match' : 'No journals yet'} emptyDescription="Journals appear once accounting is started and documents are posted." />
        <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>
      {open && <JournalDialog journal={open} canReverse={canPost} onClose={() => setOpen(null)} />}
      {creating && <NewJournalDialog onClose={() => setCreating(false)} />}
    </>
  )
}

function JournalDialog({ journal, canReverse, onClose }: { journal: JournalRow; canReverse: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const accounts = useQuery({ queryKey: ['gl-accounts'], queryFn: listAccounts, staleTime: 60_000 })
  const lines = useQuery({ queryKey: ['journal-lines', journal.id], queryFn: () => getJournalLines(journal.id) })
  const reversed = useQuery({ queryKey: ['journal-reversed', journal.id], queryFn: () => isJournalReversed(journal.id) })
  const [reason, setReason] = useState('')
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const byId = new Map((accounts.data ?? []).map((a) => [a.id, a]))
  const reversible = canReverse && (journal.source_type === 'MANUAL' || journal.source_type === 'BANK_ENTRY') && reversed.data === false
  const total = (lines.data ?? []).reduce((s, l) => s + l.debit, 0)
  const reverse = useMutation({
    mutationFn: () => reverseJournal(journal.id, reason),
    onSuccess: async () => { toast.success('Journal reversed.'); await Promise.all([...REFRESH, 'journal-reversed'].map((k) => qc.invalidateQueries({ queryKey: [k] }))); onClose() },
    onError: (e) => setError(toAppError(e).message),
  })
  return (
    <Modal open size="lg" onClose={onClose} title={journal.journal_number} description={`${journal.journal_date} · ${SOURCE_LABEL[journal.source_type] ?? journal.source_type} · ${journal.description}`}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {reversible && !asking && <Button variant="danger" onClick={() => setAsking(true)}>Reverse…</Button>}
        {reversible && asking && <Button variant="danger" loading={reverse.isPending} onClick={() => { if (reason.trim().length < 5) { setError('Give a reason for the reversal.'); return } setError(null); reverse.mutate() }}>Confirm reversal</Button>}
      </>}>
      <div className="space-y-3">
        <InlineError message={error} />
        {journal.reason && <p className="text-sm text-slate-600">Reason: {journal.reason}</p>}
        {reversed.data && <Badge tone="amber">Reversed</Badge>}
        {journal.reverses_journal_id && <Badge tone="purple">Reverses another journal</Badge>}
        {lines.isPending ? <LoadingState /> : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">Journal lines</caption>
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-2 pr-3">Account</th><th className="px-3">Memo</th><th className="px-3 text-right">Debit</th><th className="pl-3 text-right">Credit</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {(lines.data ?? []).map((l) => (
                  <tr key={l.id}><td className="py-2 pr-3">{byId.get(l.account_id) ? `${byId.get(l.account_id)!.code} · ${byId.get(l.account_id)!.name}` : l.account_id}</td><td className="px-3 text-slate-600">{l.memo ?? ''}</td>
                    <td className="px-3 text-right tabular-nums">{l.debit ? moneyFmt(l.debit) : ''}</td><td className="pl-3 text-right tabular-nums">{l.credit ? moneyFmt(l.credit) : ''}</td></tr>
                ))}
                <tr className="bg-slate-50 font-semibold"><td className="py-2 pr-3">Total</td><td /><td className="px-3 text-right tabular-nums">{moneyFmt(total)}</td><td className="pl-3 text-right tabular-nums">{moneyFmt(total)}</td></tr>
              </tbody>
            </table>
          </div>
        )}
        {asking && <Field label="Reason for the reversal" required><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoFocus /></Field>}
      </div>
    </Modal>
  )
}

interface Draft { account: string; debit: string; credit: string; memo: string }
const blank = (): Draft => ({ account: '', debit: '', credit: '', memo: '' })

function NewJournalDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const { branches, ability } = useSession()
  const accounts = useQuery({ queryKey: ['gl-accounts'], queryFn: listAccounts })
  const usable = (accounts.data ?? []).filter((a) => a.is_active && a.allow_manual)
  const [date, setDate] = useState(iso(new Date()))
  const [description, setDescription] = useState('')
  const [reason, setReason] = useState('')
  const [branchId, setBranchId] = useState('')
  const [lines, setLines] = useState<Draft[]>([blank(), blank()])
  const [error, setError] = useState<string | null>(null)
  const orgWide = ability.can('journals.create')
  const allowedBranches = branches.filter((b) => ability.can('journals.create', b.id))
  const debit = round2(lines.reduce((s, l) => s + (Number(l.debit) || 0), 0))
  const credit = round2(lines.reduce((s, l) => s + (Number(l.credit) || 0), 0))
  const balanced = debit === credit && debit > 0

  const post = useMutation({
    mutationFn: () => postManualJournal({
      date, description, reason, branchId: branchId || null,
      lines: lines.filter((l) => l.account).map((l) => ({ account_id: l.account, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, memo: l.memo })),
    }),
    onSuccess: async () => { toast.success('Journal posted.'); await Promise.all(REFRESH.map((k) => qc.invalidateQueries({ queryKey: [k] }))); onClose() },
    onError: (e) => setError(toAppError(e).message),
  })
  const set = (i: number, patch: Partial<Draft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))

  function submit() {
    const used = lines.filter((l) => l.account)
    if (description.trim().length < 3) { setError('Enter a description.'); return }
    if (used.length < 2) { setError('A journal needs at least two lines.'); return }
    if (used.some((l) => (Number(l.debit) > 0) === (Number(l.credit) > 0))) { setError('Each line is either a debit or a credit.'); return }
    if (!balanced) { setError('Debits and credits must be equal.'); return }
    setError(null)
    post.mutate()
  }

  return (
    <Modal open size="lg" onClose={onClose} title="New manual journal"
      description="For entries the documents do not cover (salaries, rent, utilities, owner's drawings ...). Accounts posted by documents are not offered. A mistake is corrected by reversing the journal."
      footer={<><Button variant="secondary" onClick={onClose} disabled={post.isPending}>Back</Button><Button onClick={submit} loading={post.isPending} disabled={!balanced}>Post journal</Button></>}>
      <div className="space-y-3">
        <InlineError message={error} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Date" required><Input type="date" value={date} max={iso(new Date())} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Description" required className="sm:col-span-2"><Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></Field>
          {(allowedBranches.length > 1 || !orgWide) && <Field label="Branch" required={!orgWide}><Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>{orgWide && <option value="">Whole organization</option>}{allowedBranches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>}
          <Field label="Reason or reference" className="sm:col-span-2"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
        </div>
        {accounts.isPending ? <LoadingState /> : (
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_8rem_8rem_1fr_auto]">
                <Select aria-label={`Account for line ${i + 1}`} value={l.account} onChange={(e) => set(i, { account: e.target.value })}><option value="">Choose account…</option>{usable.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select>
                <Input aria-label={`Debit for line ${i + 1}`} type="number" inputMode="decimal" min="0" step="0.01" placeholder="Debit" value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} />
                <Input aria-label={`Credit for line ${i + 1}`} type="number" inputMode="decimal" min="0" step="0.01" placeholder="Credit" value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} />
                <Input aria-label={`Memo for line ${i + 1}`} placeholder="Memo (optional)" value={l.memo} onChange={(e) => set(i, { memo: e.target.value })} maxLength={300} />
                <Button variant="ghost" size="sm" aria-label={`Remove line ${i + 1}`} disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" aria-hidden /></Button>
              </div>
            ))}
            <div className="flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={() => setLines((ls) => [...ls, blank()])}><Plus className="h-4 w-4" aria-hidden /> Add line</Button>
              <div className={`text-sm tabular-nums ${balanced ? 'text-emerald-700' : 'text-slate-600'}`}>Debits {moneyFmt(debit)} · Credits {moneyFmt(credit)}{!balanced && debit !== credit ? ` · off by ${moneyFmt(Math.abs(debit - credit))}` : ''}</div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
