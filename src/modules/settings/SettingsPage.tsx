import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Info } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, CardBody, CardHeader, DataTable, ErrorState, Field, InlineError, Input, LoadingState, Modal, PageHeader, Select, Tabs, Textarea, useToast, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import { listWarehouseOptions } from '@/services/warehouses'
import {
  DOCUMENT_LABEL, configureNumbering, getNumberingOverview, getSettingsOverview, numberExample, saveSetting, type NumberingRow, type SettingRow, type SettingValue,
} from '@/services/settings'
import { APP_SETTINGS_KEY } from './useAppSettings'

type SectionId = 'documents' | 'sales' | 'purchasing' | 'inventory' | 'numbering' | 'security' | 'integrations'
const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'documents', label: 'Company and documents' }, { id: 'sales', label: 'Sales and credit' }, { id: 'purchasing', label: 'Purchasing' },
  { id: 'inventory', label: 'Inventory and warehouses' }, { id: 'numbering', label: 'Document numbering' }, { id: 'security', label: 'Security and session' },
  { id: 'integrations', label: 'Notifications and integrations' },
]

interface Meta { label: string; hint: string; suffix?: string; rows?: number }
const META: Record<string, Meta> = {
  'invoice.footer': { label: 'Document footer', hint: 'A line printed at the bottom of invoices, credit notes, quotations, delivery notes and till receipts (for example "Goods once sold are not returnable without a credit note").', rows: 3 },
  'invoice.payment_instructions': { label: 'Payment instructions', hint: 'Printed on invoices and quotations: bank account, mobile money number, who to make cheques out to.', rows: 4 },
  'sales.default_payment_terms_days': { label: 'Default payment terms for new customers', hint: 'Days a new customer has to pay. You can still change it on each customer.', suffix: 'days' },
  'sales.quotation_validity_days': { label: 'Quotation validity', hint: 'How long a new quotation stays valid. You can change the date on each quotation.', suffix: 'days' },
  'credit.default_credit_limit': { label: 'Default credit limit for new customers', hint: 'The most a new customer may owe until you set their own limit. 0 means cash only.', suffix: 'GHS' },
  'purchasing.default_payment_terms_days': { label: 'Default payment terms for new suppliers', hint: 'Days you have to pay a new supplier. You can still change it on each supplier.', suffix: 'days' },
  'inventory.near_expiry_days': { label: 'Near-expiry window', hint: 'Stock expiring within this many days is flagged as near expiry on the Stock and Expiry screens.', suffix: 'days' },
  'security.idle_timeout_minutes': { label: 'Sign out after inactivity', hint: '0 turns it off. Otherwise a signed-in browser is signed out after this many minutes without use (at least 5). This protects shared counters and unattended screens; it is enforced by the app in the browser, not by the server.', suffix: 'minutes' },
}

const same = (a: SettingValue, b: SettingValue) => a === b

export function SettingsPage() {
  const { ability, branches, selectedBranch } = useSession()
  const canView = ability.can('settings.view')
  const [section, setSection] = useState<SectionId>('documents')
  const firstBranch = (selectedBranch !== 'ALL' ? selectedBranch : branches[0]?.id) ?? ''
  const [branchId, setBranchId] = useState(firstBranch)
  const overview = useQuery({ queryKey: ['settings-overview', branchId], queryFn: () => getSettingsOverview(branchId || null), enabled: canView })
  const canManage = ability.can('settings.manage')

  if (!canView) return <><PageHeader title="Settings" /><Card><CardBody><p className="text-sm text-slate-600">You do not have permission to view settings.</p></CardBody></Card></>
  const rows = new Map((overview.data ?? []).map((r) => [`${r.category}.${r.key}`, r]))
  const card = (id: string) => { const r = rows.get(id); return r ? <SettingCard key={id} row={r} meta={META[id]!} canEdit={canManage} /> : null }

  return (
    <>
      <PageHeader title="Settings" description="Configuration that the system really uses. Every change is checked by the database, needs the settings right, and is recorded in the audit log." />
      <div className="mb-4"><Tabs label="Settings sections" value={section} onChange={(v) => setSection(v as SectionId)} items={SECTIONS} /></div>
      {overview.isPending ? <LoadingState /> : overview.isError ? <ErrorState message={toAppError(overview.error).message} onRetry={() => void overview.refetch()} /> : (
        <div className="space-y-4">
          {!canManage && <p role="status" className="flex items-start gap-2 rounded-md bg-sky-50 p-3 text-sm text-sky-900"><Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> You can view settings but not change them.</p>}

          {section === 'documents' && (
            <>
              <Links title="Company profile and branches" items={[
                ['/admin/organization', 'Organization', 'Company name, registration and tax numbers, address, currency and time zone'],
                ['/admin/branches', 'Branches', 'Branch codes, contact details, head office, active or not'],
              ]} />
              {card('invoice.footer')}{card('invoice.payment_instructions')}
            </>
          )}
          {section === 'sales' && <>{card('sales.default_payment_terms_days')}{card('credit.default_credit_limit')}{card('sales.quotation_validity_days')}</>}
          {section === 'purchasing' && <>{card('purchasing.default_payment_terms_days')}</>}
          {section === 'inventory' && (
            <>
              {card('inventory.near_expiry_days')}
              <WarehouseCard row={rows.get('inventory.default_sales_warehouse')} branchId={branchId} onBranch={setBranchId} />
              <Links title="Warehouses" items={[
                ['/admin/warehouses', 'Warehouses', 'Create warehouses, set their type (main, returns, quarantine, damaged, transit)'],
                ['/admin/locations', 'Warehouse locations', 'Aisle, rack, shelf and bin, and the picking sequence'],
              ]} />
            </>
          )}
          {section === 'numbering' && <NumberingSection canManage={canManage} />}
          {section === 'security' && (
            <>
              {card('security.idle_timeout_minutes')}
              <Card>
                <CardHeader title="Managed outside this screen" description="These protections are fixed by the system or set in the hosting dashboard, so there is nothing to switch here." />
                <CardBody>
                  <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
                    <li>Nobody can sign themselves up: people join by invitation from Administration → Users.</li>
                    <li>Passwords need 12 or more characters with upper case, lower case and a digit.</li>
                    <li>Roles and branch access are managed on Administration → Users and Roles &amp; permissions.</li>
                    <li>Two-factor sign-in, sign-in rate limits, the email sender and backups are set in the Supabase dashboard (see the production readiness checklist).</li>
                  </ul>
                </CardBody>
              </Card>
            </>
          )}
          {section === 'integrations' && (
            <>
              <Card><CardHeader title="Notifications" /><CardBody><p className="text-sm text-slate-700">No notification channel (email, SMS or WhatsApp) is connected yet, so there is nothing to configure. Payment reminders are prepared as text you send yourself from Sales → Payment reminders.</p></CardBody></Card>
              <Card>
                <CardHeader title="Integrations" description="Placeholders: none of these connections exists yet, so they have no settings." />
                <ul className="divide-y divide-slate-100">
                  {[['DrugXOne', 'Share availability and prices, receive pharmacy orders'], ['Ghana Revenue Authority e-VAT', 'Issue tax invoices to the authority (needs its specification and credentials)'], ['Payment gateways', 'Card and mobile-money collection']].map(([n, d]) => (
                    <li key={n} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5"><div className="min-w-0 flex-1"><div className="font-medium text-slate-900">{n}</div><div className="text-xs text-slate-500">{d}</div></div><Badge>Not connected</Badge></li>
                  ))}
                </ul>
              </Card>
            </>
          )}
        </div>
      )}
    </>
  )
}

function Links({ title, items }: { title: string; items: [string, string, string][] }) {
  return (
    <Card>
      <CardHeader title={title} description="Edited on their own screens." />
      <ul className="grid gap-2 p-4 sm:grid-cols-2 sm:p-5">
        {items.map(([to, t, d]) => <li key={to}><Link to={to} className="block rounded-md border border-slate-200 p-3 hover:bg-slate-50"><span className="font-medium text-slate-900">{t}</span><span className="block text-xs text-slate-500">{d}</span></Link></li>)}
      </ul>
    </Card>
  )
}

const REFRESH = ['settings-overview', APP_SETTINGS_KEY]

function SourceBadge({ source }: { source: SettingRow['source'] }) {
  return <Badge tone={source === 'default' ? 'slate' : 'green'}>{source === 'default' ? 'Default' : source === 'organization' ? 'Saved' : 'Saved for this branch'}</Badge>
}

function parse(row: SettingRow, text: string): { ok: true; value: SettingValue } | { ok: false; error: string } {
  if (row.kind === 'text') {
    if (row.max_len !== null && text.length > row.max_len) return { ok: false, error: `At most ${row.max_len} characters (now ${text.length}).` }
    return { ok: true, value: text }
  }
  if (text.trim() === '') return { ok: false, error: 'Enter a number.' }
  const n = Number(text)
  if (!Number.isFinite(n)) return { ok: false, error: 'Enter a number.' }
  if (row.kind === 'int' && !Number.isInteger(n)) return { ok: false, error: 'Whole numbers only.' }
  if (row.kind === 'number' && Math.abs(Math.round(n * 100) / 100 - n) > 1e-9) return { ok: false, error: 'At most 2 decimals.' }
  if (row.min_num !== null && n < row.min_num) return { ok: false, error: `At least ${row.min_num}.` }
  if (row.max_num !== null && n > row.max_num) return { ok: false, error: `At most ${row.max_num}.` }
  if (row.min_nonzero !== null && n !== 0 && n < row.min_nonzero) return { ok: false, error: `Use 0 (off) or at least ${row.min_nonzero}.` }
  return { ok: true, value: n }
}

function SettingCard({ row, meta, canEdit }: { row: SettingRow; meta: Meta; canEdit: boolean }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [draft, setDraft] = useState(row.value === null ? '' : String(row.value))
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState<SettingValue | undefined>(undefined)
  const [reason, setReason] = useState('')
  const parsed = parse(row, draft)
  const changed = parsed.ok ? !same(parsed.value, row.value) : true

  const save = useMutation({
    mutationFn: (v: { value: SettingValue; reason?: string }) => saveSetting({ category: row.category, key: row.key, value: v.value, ...(v.reason ? { reason: v.reason } : {}) }),
    onSuccess: async (_d, v) => {
      toast.success(v.value === null ? 'Back to the default.' : 'Saved.')
      setAsking(undefined); setReason(''); setError(null)
      if (v.value === null) setDraft(row.default_value === null ? '' : String(row.default_value))
      await Promise.all(REFRESH.map((k) => qc.invalidateQueries({ queryKey: [k] })))
    },
    onError: (e) => setError(toAppError(e).message),
  })
  function go(value: SettingValue) { if (row.sensitive) { setAsking(value); setError(null) } else save.mutate({ value }) }

  return (
    <Card>
      <CardHeader title={meta.label} description={meta.hint} actions={<SourceBadge source={row.source} />} />
      <CardBody>
        <InlineError message={asking === undefined ? error : null} />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label={meta.label} error={parsed.ok || !changed ? undefined : parsed.error} hint={meta.suffix ? `In ${meta.suffix}` : undefined} className="flex-1">
            {row.kind === 'text'
              ? <Textarea rows={meta.rows ?? 3} maxLength={row.max_len ?? undefined} value={draft} disabled={!canEdit} onChange={(e) => setDraft(e.target.value)} />
              : <Input type="number" inputMode="decimal" value={draft} disabled={!canEdit} onChange={(e) => setDraft(e.target.value)} className="sm:max-w-[12rem]" />}
          </Field>
          {canEdit && (
            <div className="flex gap-2">
              <Button disabled={!changed || !parsed.ok} loading={save.isPending && asking === undefined} onClick={() => parsed.ok && go(parsed.value)}>Save</Button>
              {row.source !== 'default' && <Button variant="ghost" disabled={save.isPending} onClick={() => go(null)}>Reset to default</Button>}
            </div>
          )}
        </div>
      </CardBody>
      {asking !== undefined && (
        <Modal open size="md" onClose={() => setAsking(undefined)} title={`Change: ${meta.label}`} description="This is a security setting, so the reason is kept with the audit entry."
          footer={<><Button variant="secondary" onClick={() => setAsking(undefined)} disabled={save.isPending}>Back</Button>
            <Button loading={save.isPending} onClick={() => { if (reason.trim().length < 5) { setError('Give a reason (at least 5 characters).'); return } setError(null); save.mutate({ value: asking, reason }) }}>Confirm</Button></>}>
          <div className="space-y-3"><InlineError message={error} /><Field label="Reason" required><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoFocus /></Field></div>
        </Modal>
      )}
    </Card>
  )
}

function WarehouseCard({ row, branchId, onBranch }: { row: SettingRow | undefined; branchId: string; onBranch: (id: string) => void }) {
  const { ability, branches } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const warehouses = useQuery({ queryKey: ['warehouse-options', null], queryFn: () => listWarehouseOptions(null), staleTime: 60_000 })
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const canEdit = Boolean(branchId) && ability.can('settings.manage', branchId)
  const options = (warehouses.data ?? []).filter((w) => w.is_active && w.branch_id === branchId)
  const current = typeof row?.value === 'string' ? row.value : ''
  const chosen = draft ?? current
  const save = useMutation({
    mutationFn: (value: string | null) => saveSetting({ category: 'inventory', key: 'default_sales_warehouse', value, branchId }),
    onSuccess: async (_d, value) => { toast.success(value === null ? 'Back to the default.' : 'Saved.'); setDraft(null); setError(null); await Promise.all(REFRESH.map((k) => qc.invalidateQueries({ queryKey: [k] }))) },
    onError: (e) => setError(toAppError(e).message),
  })
  return (
    <Card>
      <CardHeader title="Default sales warehouse for a branch" description="The warehouse that new invoices, quotations, orders and till shifts at that branch start with. Without one, the branch's first warehouse is offered. The user can still choose another." actions={row ? <SourceBadge source={row.source} /> : undefined} />
      <CardBody>
        <InlineError message={error} />
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Branch"><Select value={branchId} onChange={(e) => { onBranch(e.target.value); setDraft(null) }}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          <Field label="Sell from"><Select value={chosen} disabled={!canEdit} onChange={(e) => setDraft(e.target.value)}><option value="">Branch's first warehouse</option>{options.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}</Select></Field>
          {canEdit && (
            <div className="flex gap-2">
              <Button disabled={!chosen || chosen === current} loading={save.isPending} onClick={() => save.mutate(chosen)}>Save</Button>
              {current && <Button variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>Reset</Button>}
            </div>
          )}
        </div>
        {!canEdit && branchId && <p className="mt-2 text-xs text-slate-500">You do not have the settings right for this branch.</p>}
      </CardBody>
    </Card>
  )
}

function NumberingSection({ canManage }: { canManage: boolean }) {
  const [editing, setEditing] = useState<NumberingRow | null>(null)
  const query = useQuery({ queryKey: ['numbering-overview'], queryFn: getNumberingOverview })
  const columns: Column<NumberingRow>[] = [
    { key: 'doc', header: 'Document', render: (r) => <span className="font-medium text-slate-900">{DOCUMENT_LABEL[r.document_type] ?? r.document_type}</span> },
    { key: 'ex', header: 'Next number', render: (r) => <span className="font-mono text-xs">{numberExample(r.prefix, r.padding, r.reset_period, r.next_number)}</span> },
    { key: 'reset', header: 'Restarts', hideOnMobile: true, render: (r) => ({ NEVER: 'Never', YEARLY: 'Every year', MONTHLY: 'Every month' })[r.reset_period] },
    { key: 'st', header: 'Status', hideOnMobile: true, render: (r) => (r.in_use ? <Badge tone="blue">In use</Badge> : r.configured ? <Badge tone="green">Configured</Badge> : <Badge>Default</Badge>) },
    { key: 'act', header: '', className: 'text-right', render: (r) => (canManage ? <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>Edit</Button> : null) },
  ]
  return (
    <>
      <Card>
        <CardHeader title="Document numbering" description="How document numbers look. The counter never goes back, and a prefix cannot be shared between two kinds of document, so a number is never issued twice. Changes apply to the next number issued." />
        <DataTable caption="Document numbering" columns={columns} rows={query.data} rowKey={(r) => r.document_type} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()} />
      </Card>
      {editing && <NumberingDialog row={editing} onClose={() => setEditing(null)} />}
    </>
  )
}

function NumberingDialog({ row, onClose }: { row: NumberingRow; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [prefix, setPrefix] = useState(row.prefix)
  const [padding, setPadding] = useState(String(row.padding))
  const [reset, setReset] = useState<string>(row.reset_period)
  const [error, setError] = useState<string | null>(null)
  const p = prefix.trim().toUpperCase()
  const save = useMutation({
    mutationFn: () => configureNumbering({ documentType: row.document_type, prefix: p, padding: Number(padding), resetPeriod: reset }),
    onSuccess: async () => { toast.success('Numbering saved.'); await qc.invalidateQueries({ queryKey: ['numbering-overview'] }); onClose() },
    onError: (e) => setError(toAppError(e).message),
  })
  function submit() {
    if (!/^([A-Z0-9]|[A-Z0-9][A-Z0-9-]{0,14}[A-Z0-9])$/.test(p)) { setError('The prefix is 1 to 16 letters, digits or dashes, and cannot start or end with a dash.'); return }
    const n = Number(padding)
    if (!Number.isInteger(n) || n < 3 || n > 12) { setError('The number length is between 3 and 12 digits.'); return }
    setError(null)
    save.mutate()
  }
  return (
    <Modal open size="md" onClose={onClose} title={`Numbering: ${DOCUMENT_LABEL[row.document_type] ?? row.document_type}`}
      description={row.in_use ? 'Numbers have been issued: the counter carries on, and the restart period can no longer change.' : 'No number has been issued yet, so everything can change.'}
      footer={<><Button variant="secondary" onClick={onClose} disabled={save.isPending}>Back</Button><Button loading={save.isPending} onClick={submit}>Save</Button></>}>
      <div className="space-y-3">
        <InlineError message={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Prefix" required><Input value={prefix} onChange={(e) => setPrefix(e.target.value)} maxLength={16} autoFocus /></Field>
          <Field label="Digits" required hint="Padded with zeros"><Input type="number" inputMode="numeric" value={padding} onChange={(e) => setPadding(e.target.value)} /></Field>
        </div>
        <Field label="Restart numbering" hint={row.in_use ? 'Fixed once numbers have been issued.' : undefined}>
          <Select value={reset} disabled={row.in_use} onChange={(e) => setReset(e.target.value)}><option value="YEARLY">Every year</option><option value="MONTHLY">Every month</option><option value="NEVER">Never</option></Select>
        </Field>
        <p className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">Next number will look like: <span className="font-mono font-semibold">{numberExample(p, Number(padding) || 6, reset, row.next_number)}</span></p>
      </div>
    </Modal>
  )
}

