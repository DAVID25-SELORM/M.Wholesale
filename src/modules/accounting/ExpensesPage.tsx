import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Button, Card, CardBody, Field, Input, Select, PageHeader, InlineError } from '@/components/ui'
import { useSession } from '@/modules/session/SessionProvider'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/services/common'
import { toAppError } from '@/lib/errors'
import { listAccounts } from '@/services/accounting'

export function ExpensesPage() { const { selectedBranch } = useSession(); return <Expenses key={selectedBranch} /> }
function Expenses() {
  const { selectedBranch, branches, ability, context } = useSession(); const qc = useQueryClient()
  const [branch, setBranch] = useState(selectedBranch === 'ALL' ? '' : selectedBranch)
  const [values, setValues] = useState<Record<string, string>>({})
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [page, setPage] = useState(0); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null)
  const accounts = useQuery({ queryKey: ['gl-accounts'], queryFn: listAccounts })
  const query = useQuery({ queryKey: ['expenses', selectedBranch, page], queryFn: async () => { let q = supabase.from('expenses').select('*').order('created_at', { ascending: false }).order('id').range(page * 25, page * 25 + 24); if (selectedBranch !== 'ALL') q = q.eq('branch_id', selectedBranch); return unwrap(await q, 'expenses.list') } })
  async function act(fn: () => Promise<void>) { if (busy) return; setBusy(true); setError(null); try { await fn(); await qc.invalidateQueries({ queryKey: ['expenses'] }) } catch (e) { setError(toAppError(e).message) } finally { setBusy(false) } }
  return <div className="space-y-4">
    <PageHeader title="Expenses" description="Submit expense entries for independent approval. Approval posts a balanced journal; it does not send a payment. Select the credit account according to how the expense was funded or accrued." />
    <InlineError message={error ?? (query.isError ? toAppError(query.error).message : accounts.isError ? toAppError(accounts.error).message : null)} />
    {ability.canAnywhere('journals.create') && <Card><CardBody><form className="grid gap-3 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); void act(async () => { unwrap(await supabase.rpc('submit_expense', { p_branch: branch, p_date: values.date!, p_payee: values.payee!, p_description: values.description!, p_reference: values.reference!, p_expense_account: values.expense_account!, p_credit_account: values.credit_account!, p_amount: Number(values.amount) }), 'expenses.submit'); setValues({}); setPage(0) }) }}>
      <Field label="Branch"><Select required value={branch} onChange={e => setBranch(e.target.value)}><option value="">Choose branch</option>{branches.filter(b => b.is_active && ability.can('journals.create', b.id)).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
      {([{ name: 'date', label: 'Expense date', type: 'date' }, { name: 'payee', label: 'Payee', type: 'text' }, { name: 'description', label: 'Description', type: 'text' }, { name: 'reference', label: 'Receipt or invoice reference', type: 'text' }, { name: 'amount', label: 'Amount (organization currency)', type: 'number' }]).map(f => <Field key={f.name} label={f.label}><Input required type={f.type} min={f.type === 'number' ? '0.01' : undefined} step={f.type === 'number' ? '0.01' : undefined} maxLength={f.name === 'payee' ? 200 : f.name === 'description' ? 1000 : 100} value={values[f.name] ?? ''} onChange={e => setValues({ ...values, [f.name]: e.target.value })} /></Field>)}
      {(['expense_account', 'credit_account'] as const).map(name => <Field key={name} label={name === 'expense_account' ? 'Expense account' : 'Credit account'}><Select required value={values[name] ?? ''} onChange={e => setValues({ ...values, [name]: e.target.value })}><option value="">Choose account</option>{accounts.data?.filter(a => a.is_active && a.allow_manual && (name === 'expense_account' ? a.account_type === 'EXPENSE' : ['ASSET', 'LIABILITY'].includes(a.account_type))).map(a => <option key={a.id} value={a.id}>{a.code} / {a.name}</option>)}</Select></Field>)}
      <Button type="submit" disabled={busy}>Submit expense</Button>
    </form></CardBody></Card>}
    {query.isError && <Button onClick={() => void query.refetch()}>Retry</Button>}
    {query.isPending ? <p>Loading...</p> : !query.data?.length ? <p>No expenses on this page.</p> : query.data.map(e => <Card key={e.id}><CardBody className="space-y-2"><h2 className="font-semibold">{e.payee} / {e.reference}</h2><p>{e.description}</p><p>{e.expense_date} / {e.amount} / {e.status}</p><p>{e.decision_note}</p>{e.journal_id && <Link className="underline" to="/accounting/journals">Review posted journal and any reversal in Journals</Link>}{e.status === 'SUBMITTED' && <><Field label={`Decision reason ${e.reference}`}><Input maxLength={500} value={reasons[e.id] ?? ''} onChange={v => setReasons({ ...reasons, [e.id]: v.target.value })} /></Field><div className="flex flex-wrap gap-2">{(e.requested_by === context.user_id ? ability.can('journals.create', e.branch_id) ? ['CANCEL'] : [] : ability.can('expenses.approve', e.branch_id) ? ['APPROVE', 'REJECT'] : []).map(action => <Button key={action} disabled={busy || (reasons[e.id] ?? '').trim().length < 3} onClick={() => void act(async () => { unwrap(await supabase.rpc('decide_expense', { p_id: e.id, p_action: action, p_note: reasons[e.id]! }), 'expenses.decide') })}>{action === 'APPROVE' ? 'Approve and post' : action === 'REJECT' ? 'Reject' : 'Cancel'}</Button>)}</div></>}</CardBody></Card>)}
    <div className="flex gap-3"><Button disabled={!page || query.isFetching} onClick={() => setPage(page - 1)}>Previous</Button><span>Page {page + 1}</span><Button disabled={query.isFetching || query.data?.length !== 25} onClick={() => setPage(page + 1)}>Next</Button></div>
  </div>
}
