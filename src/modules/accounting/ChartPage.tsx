import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, DataTable, Field, InlineError, Input, Modal, PageHeader, Select, StatusBadge, useToast, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABEL, listAccounts, saveAccount, type AccountType, type GlAccount } from '@/services/accounting'

export function ChartPage() {
  const { ability } = useSession()
  const canManage = ability.can('accounting.manage')
  const [editing, setEditing] = useState<GlAccount | 'new' | null>(null)
  const [type, setType] = useState('')
  const query = useQuery({ queryKey: ['gl-accounts'], queryFn: listAccounts })
  const rows = (query.data ?? []).filter((a) => !type || a.account_type === type)

  const columns: Column<GlAccount>[] = [
    { key: 'code', header: 'Code', render: (a) => <span className="font-mono text-xs font-semibold">{a.code}</span> },
    { key: 'name', header: 'Account', render: (a) => <Link to={`/accounting/ledger?account=${a.id}`} className="font-medium text-slate-900 hover:underline">{a.name}</Link> },
    { key: 'type', header: 'Type', hideOnMobile: true, render: (a) => <span className="text-slate-600">{ACCOUNT_TYPE_LABEL[a.account_type]}</span> },
    { key: 'sys', header: 'Posted by', hideOnMobile: true, render: (a) => (a.is_system ? <Badge tone="blue">System{a.allow_manual ? '' : ' (documents only)'}</Badge> : <span className="text-xs text-slate-500">You</span>) },
    { key: 'st', header: 'Status', render: (a) => <StatusBadge active={a.is_active} /> },
    { key: 'act', header: '', className: 'text-right', render: (a) => (canManage ? <Button size="sm" variant="ghost" onClick={() => setEditing(a)}>Edit</Button> : null) },
  ]

  return (
    <>
      <PageHeader title="Chart of accounts" description="Accounts marked 'documents only' (receivables, inventory, payables, sales, cost of goods ...) are posted by sales, stock and purchase documents so the ledger always agrees with the customer, stock and supplier records; nobody posts to them by hand."
        actions={canManage ? <Button onClick={() => setEditing('new')}>Add account</Button> : undefined} />
      <Card>
        <div className="border-b border-slate-100 p-4 sm:w-64">
          <label htmlFor="coa-type" className="sr-only">Type</label>
          <Select id="coa-type" value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{ACCOUNT_TYPE_LABEL[t]}</option>)}</Select>
        </div>
        <DataTable caption="Chart of accounts" columns={columns} rows={query.isSuccess ? rows : undefined} rowKey={(a) => a.id} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()} emptyTitle="No accounts" />
      </Card>
      {editing && <AccountDialog account={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  )
}

function AccountDialog({ account, onClose }: { account: GlAccount | null; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [code, setCode] = useState(account?.code ?? '')
  const [name, setName] = useState(account?.name ?? '')
  const [type, setType] = useState<AccountType>(account?.account_type ?? 'EXPENSE')
  const [active, setActive] = useState(account?.is_active ?? true)
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: () => saveAccount({ id: account?.id ?? null, code, name, type, active }),
    onSuccess: async () => { toast.success('Account saved.'); await qc.invalidateQueries({ queryKey: ['gl-accounts'] }); onClose() },
    onError: (e) => setError(toAppError(e).message),
  })
  function submit(e: FormEvent) {
    e.preventDefault()
    if (!/^[A-Za-z0-9.-]{2,12}$/.test(code.trim())) { setError('The code is 2-12 letters, digits, dots or dashes.'); return }
    if (name.trim().length < 2) { setError('Enter the account name.'); return }
    setError(null)
    save.mutate()
  }
  return (
    <Modal open size="md" onClose={onClose} title={account ? `Edit ${account.name}` : 'Add account'}
      description={account?.is_system ? 'A system account can be renamed and renumbered, but not retyped or deactivated.' : 'Accounts that already have postings cannot change type.'}
      footer={<><Button variant="secondary" onClick={onClose} disabled={save.isPending}>Back</Button><Button type="submit" form="account-form" loading={save.isPending}>Save</Button></>}>
      <form id="account-form" onSubmit={submit} noValidate className="space-y-3">
        <InlineError message={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code" required><Input value={code} onChange={(e) => setCode(e.target.value)} maxLength={12} autoFocus /></Field>
          <Field label="Type" required><Select value={type} disabled={Boolean(account?.is_system)} onChange={(e) => setType(e.target.value as AccountType)}>{ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{ACCOUNT_TYPE_LABEL[t]}</option>)}</Select></Field>
        </div>
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
        {!account?.is_system && account && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active (inactive accounts cannot receive new postings)</label>}
      </form>
    </Modal>
  )
}
