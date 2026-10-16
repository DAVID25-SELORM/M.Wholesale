import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Upload } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Badge, Button, Card, CardHeader, DataTable, EmptyState, Field, InlineError, Input, Modal, PageHeader, Select, StatusBadge, useToast, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { FileProblem, readTable } from '@/modules/imports/parseFile'
import { useSession } from '@/modules/session/SessionProvider'
import { createBankAccount, importStatement, listBankAccounts, listStatements, saveBankAccount, type BankAccount, type BankStatement } from '@/services/accounting'
import { moneyFmt, round2 } from '@/services/sales'
import { StatementProblem, parseStatement, type ParsedStatement } from './statementParse'

export function BankPage() {
  const { ability } = useSession()
  const canReconcile = ability.can('bank.reconcile')
  const canManage = ability.can('accounting.manage')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<BankAccount | null>(null)
  const [importing, setImporting] = useState(false)
  const accounts = useQuery({ queryKey: ['bank-accounts'], queryFn: listBankAccounts })
  const statements = useQuery({ queryKey: ['bank-statements'], queryFn: () => listStatements(null) })
  const nameOf = new Map((accounts.data ?? []).map((a) => [a.id, a.name]))

  const columns: Column<BankStatement>[] = [
    { key: 'acct', header: 'Account', render: (s) => <span className="font-medium text-slate-900">{nameOf.get(s.bank_account_id) ?? '—'}</span> },
    { key: 'period', header: 'Period', render: (s) => <Link to={`/accounting/bank/statements/${s.id}`} className="whitespace-nowrap text-slate-900 hover:underline">{s.period_from} to {s.period_to}</Link> },
    { key: 'open', header: 'Opening', hideOnMobile: true, className: 'text-right', render: (s) => <span className="tabular-nums">{moneyFmt(s.opening_balance)}</span> },
    { key: 'close', header: 'Closing', className: 'text-right', render: (s) => <span className="tabular-nums">{moneyFmt(s.closing_balance)}</span> },
    { key: 'st', header: 'Status', render: (s) => <Badge tone={s.status === 'RECONCILED' ? 'green' : 'amber'}>{s.status === 'RECONCILED' ? 'Reconciled' : 'Open'}</Badge> },
    { key: 'go', header: '', className: 'text-right', render: (s) => <Link to={`/accounting/bank/statements/${s.id}`} className="text-sm font-medium text-brand-700 hover:underline">{s.status === 'OPEN' && canReconcile ? 'Reconcile' : 'View'}</Link> },
  ]

  return (
    <>
      <PageHeader title="Bank reconciliation" description="Import a bank or mobile-money statement, match each line to what the books already show, book bank charges, and finish when the difference is nil."
        actions={<>{canReconcile && <Button variant="secondary" onClick={() => setCreating(true)}>New bank account</Button>}{canReconcile && <Button onClick={() => setImporting(true)} disabled={(accounts.data ?? []).length === 0}><Upload className="h-4 w-4" aria-hidden /> Import statement</Button>}</>} />
      <div className="space-y-4">
        <Card>
          <CardHeader title="Bank and wallet accounts" description="Bank transfers, cheques and supplier payments go to the default account." />
          <ul className="divide-y divide-slate-100">
            {(accounts.data ?? []).map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                <div className="min-w-0 flex-1"><div className="font-medium text-slate-900">{a.name}</div><div className="text-xs text-slate-500">{[a.bank_name, a.account_ref].filter(Boolean).join(' · ') || 'No bank details yet'}</div></div>
                {a.is_default && <Badge tone="blue">Default</Badge>}<StatusBadge active={a.is_active} />
                {canManage && <Button size="sm" variant="ghost" onClick={() => setEditing(a)}>Edit</Button>}
              </li>
            ))}
            {accounts.isSuccess && accounts.data.length === 0 && <li><EmptyState title="No bank accounts yet" /></li>}
          </ul>
        </Card>
        <Card>
          <CardHeader title="Statements" />
          <DataTable caption="Bank statements" columns={columns} rows={statements.data} rowKey={(s) => s.id} loading={statements.isFetching}
            error={statements.isError ? toAppError(statements.error).message : null} onRetry={() => void statements.refetch()}
            emptyTitle="No statements imported" emptyDescription="Import the statement from your bank (Excel or CSV) to start reconciling." />
        </Card>
      </div>
      {creating && <NewAccountDialog onClose={() => setCreating(false)} />}
      {editing && <EditAccountDialog account={editing} onClose={() => setEditing(null)} />}
      {importing && <ImportDialog accounts={(accounts.data ?? []).filter((a) => a.is_active)} onClose={() => setImporting(false)} />}
    </>
  )
}

function NewAccountDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [name, setName] = useState('')
  const [bank, setBank] = useState('')
  const [ref, setRef] = useState('')
  const [error, setError] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: () => createBankAccount(name, bank, ref),
    onSuccess: async () => { toast.success('Bank account added.'); await Promise.all(['bank-accounts', 'gl-accounts'].map((k) => qc.invalidateQueries({ queryKey: [k] }))); onClose() },
    onError: (e) => setError(toAppError(e).message),
  })
  function submit(e: FormEvent) { e.preventDefault(); if (name.trim().length < 2) { setError('Enter a name.'); return } setError(null); create.mutate() }
  return (
    <Modal open size="md" onClose={onClose} title="New bank account" description="A ledger account is created for it automatically."
      footer={<><Button variant="secondary" onClick={onClose} disabled={create.isPending}>Back</Button><Button type="submit" form="bank-new" loading={create.isPending}>Add</Button></>}>
      <form id="bank-new" onSubmit={submit} noValidate className="space-y-3">
        <InlineError message={error} />
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus placeholder="e.g. Ecobank current account" /></Field>
        <Field label="Bank"><Input value={bank} onChange={(e) => setBank(e.target.value)} maxLength={120} /></Field>
        <Field label="Account number or reference" hint="Shown to your team; store only what is needed to recognise the account."><Input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={40} /></Field>
      </form>
    </Modal>
  )
}

function EditAccountDialog({ account, onClose }: { account: BankAccount; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [name, setName] = useState(account.name)
  const [bank, setBank] = useState(account.bank_name ?? '')
  const [ref, setRef] = useState(account.account_ref ?? '')
  const [active, setActive] = useState(account.is_active)
  const [makeDefault, setMakeDefault] = useState(account.is_default)
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: () => saveBankAccount({ id: account.id, name, bankName: bank, accountRef: ref, active, makeDefault }),
    onSuccess: async () => { toast.success('Bank account saved.'); await qc.invalidateQueries({ queryKey: ['bank-accounts'] }); onClose() },
    onError: (e) => setError(toAppError(e).message),
  })
  return (
    <Modal open size="md" onClose={onClose} title={`Edit ${account.name}`}
      footer={<><Button variant="secondary" onClick={onClose} disabled={save.isPending}>Back</Button><Button loading={save.isPending} onClick={() => { if (name.trim().length < 2) { setError('Enter a name.'); return } setError(null); save.mutate() }}>Save</Button></>}>
      <div className="space-y-3">
        <InlineError message={error} />
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
        <Field label="Bank"><Input value={bank} onChange={(e) => setBank(e.target.value)} maxLength={120} /></Field>
        <Field label="Account number or reference"><Input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={40} /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} disabled={account.is_default && makeDefault} onChange={(e) => setActive(e.target.checked)} /> Active</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={makeDefault} disabled={account.is_default} onChange={(e) => { setMakeDefault(e.target.checked); if (e.target.checked) setActive(true) }} /> Default for bank transfers, cheques and supplier payments</label>
      </div>
    </Modal>
  )
}

function ImportDialog({ accounts, onClose }: { accounts: BankAccount[]; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)
  const [accountId, setAccountId] = useState(accounts.find((a) => a.is_default)?.id ?? accounts[0]?.id ?? '')
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState<ParsedStatement | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [opening, setOpening] = useState('')
  const [closing, setClosing] = useState('')
  const [error, setError] = useState<string | null>(null)

  const imp = useMutation({
    mutationFn: () => importStatement({ bankAccountId: accountId, from, to, opening: Number(opening), closing: Number(closing), lines: parsed!.lines, fileName }),
    onSuccess: async (id) => { toast.success('Statement imported. Now match its lines.'); await qc.invalidateQueries({ queryKey: ['bank-statements'] }); onClose(); navigate(`/accounting/bank/statements/${id}`) },
    onError: (e) => setError(toAppError(e).message),
  })

  async function pick(file: File | undefined) {
    setParsed(null); setError(null)
    if (!file) return
    try {
      const p = parseStatement(await readTable(file))
      setParsed(p); setFileName(file.name); setFrom(p.from); setTo(p.to)
    } catch (e) {
      setError(e instanceof FileProblem || e instanceof StatementProblem ? e.message : toAppError(e).message)
    }
  }

  const expectedClosing = opening.trim() !== '' && parsed ? round2(Number(opening) + parsed.total) : null
  function submit() {
    if (!parsed) { setError('Choose the statement file first.'); return }
    if (opening.trim() === '' || closing.trim() === '' || !Number.isFinite(Number(opening)) || !Number.isFinite(Number(closing))) { setError('Enter the opening and closing balances printed on the statement.'); return }
    if (from > to) { setError('The period start is after its end.'); return }
    setError(null)
    imp.mutate()
  }

  return (
    <Modal open size="lg" onClose={onClose} title="Import a bank statement"
      description="An Excel (.xlsx) or CSV export with a Date column, an Amount column (money out negative) or separate Debit and Credit columns, and optionally Description and Reference."
      footer={<><Button variant="secondary" onClick={onClose} disabled={imp.isPending}>Back</Button><Button onClick={submit} loading={imp.isPending} disabled={!parsed}>Import</Button></>}>
      <div className="space-y-3">
        <InlineError message={error} />
        <Field label="Bank account" required><Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        <Field label="Statement file" required><input ref={fileRef} type="file" accept=".csv,.txt,.xlsx" className="block w-full text-sm" onChange={(e) => void pick(e.target.files?.[0])} /></Field>
        {parsed && (
          <>
            <p className="text-sm text-slate-600">{parsed.lines.length} transactions, net {moneyFmt(parsed.total)}, dated {parsed.from} to {parsed.to}.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Period from" required><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
              <Field label="Period to" required><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
              <Field label="Opening balance" required hint="As printed on the statement."><Input type="number" inputMode="decimal" step="0.01" value={opening} onChange={(e) => setOpening(e.target.value)} /></Field>
              <Field label="Closing balance" required hint={expectedClosing !== null ? `Opening plus the transactions is ${moneyFmt(expectedClosing)}.` : 'As printed on the statement.'}><Input type="number" inputMode="decimal" step="0.01" value={closing} onChange={(e) => setClosing(e.target.value)} /></Field>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
