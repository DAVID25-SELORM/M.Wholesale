import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { Button, Field, Input, InlineError, Modal, PageHeader, useToast } from '@/components/ui'
import { collectPlatformExport, exportRecords, readPlatform, textValue, writePlatform, type RecordData } from './api'
import { UserRoleEditor } from './UserRoleEditor'
import { OrganizationDetail } from './OrganizationDetail'
import { RevenueSummary } from './RevenueSummary'

type FormField = { key: string; label: string; type?: string; options?: string[] }
const formFields: Record<string, FormField[]> = {
  'ticket.tenant_reply': [{ key: 'body', label: 'Reply visible to the organization' }],
  'operator.save': [{ key: 'email', label: 'Verified administrator email', type: 'email' }],
  'organization.update': [{ key: 'name', label: 'Organization name' }, { key: 'email', label: 'Business email', type: 'email' }, { key: 'phone', label: 'Phone' }, { key: 'address', label: 'Address' }],
  'plan.save': ['name', 'currency', 'monthly_price', 'annual_price', 'user_limit', 'branch_limit', 'warehouse_limit', 'trial_days'].map(key => ({ key, label: key.replaceAll('_', ' '), type: /price|limit|days/.test(key) ? 'number' : 'text' })),
  'subscription.save': [{ key: 'organization_id', label: 'Organization ID' }, { key: 'plan_id', label: 'Plan ID' }, { key: 'cycle', label: 'Billing cycle', options: ['MONTHLY', 'ANNUAL'] }, { key: 'status', label: 'Status', options: ['TRIAL', 'ACTIVE', 'CANCELLED'] }, { key: 'starts_on', label: 'Starts on', type: 'date' }, { key: 'ends_on', label: 'Ends on', type: 'date' }],
  'ticket.create': [{ key: 'subject', label: 'Subject' }, { key: 'body', label: 'Description' }, { key: 'priority', label: 'Priority', options: ['NORMAL', 'LOW', 'HIGH', 'URGENT'] }],
  'ticket.update': [{ key: 'status', label: 'Status', options: ['OPEN', 'IN_PROGRESS', 'CLOSED'] }, { key: 'priority', label: 'Priority', options: ['NORMAL', 'LOW', 'HIGH', 'URGENT'] }],
  'ticket.reply': [{ key: 'body', label: 'Reply' }],
  'announcement.create': [{ key: 'title', label: 'Title' }, { key: 'body', label: 'Message' }, { key: 'expires_at', label: 'Expires at', type: 'datetime-local' }],
  'settings.save': ['name', 'support_email', 'support_phone', 'country', 'currency', 'timezone'].map(key => ({ key, label: key.replaceAll('_', ' ') })),
}
const sections: Record<string, { title: string; columns: string[]; create?: string }> = {
  onboarding: { title: 'Onboarding approvals', columns: ['name', 'owner_email', 'details', 'status', 'attempts', 'failure_code', 'decision_note', 'created_at'] },
  invoices: { title: 'Platform invoices', columns: ['id', 'organization', 'period_start', 'period_end', 'currency', 'amount', 'status'] },
  payments: { title: 'Verified payments', columns: ['invoice_id', 'provider', 'provider_reference', 'currency', 'amount', 'verified_at'] },
  organizations: { title: 'Organizations', columns: ['name', 'owner_email', 'country', 'currency_code', 'plan', 'is_active', 'archived_at', 'created_at'] },
  users: { title: 'Users', columns: ['name', 'email', 'organization', 'roles', 'is_active'] },
  operators: { title: 'Platform administrators', columns: ['email', 'permissions', 'is_active'], create: 'operator.save' },
  plans: { title: 'Subscription plans', columns: ['id', 'name', 'currency', 'monthly_price', 'annual_price', 'user_limit', 'branch_limit', 'warehouse_limit', 'is_active'], create: 'plan.save' },
  subscriptions: { title: 'Organization subscriptions', columns: ['organization', 'plan', 'cycle', 'status', 'starts_on', 'ends_on'], create: 'subscription.save' },
  tickets: { title: 'Support tickets', columns: ['subject', 'priority', 'status', 'assigned_to', 'created_at'], create: 'ticket.create' },
  announcements: { title: 'Announcements', columns: ['title', 'body', 'tenant_visible', 'published_at', 'expires_at'], create: 'announcement.create' },
  audit: { title: 'Audit log', columns: ['created_at', 'actor_id', 'action', 'organization_id', 'result', 'metadata'] },
  notifications: { title: 'Notifications', columns: ['created_at', 'action', 'organization_id', 'is_read'] },
}

export function PlatformPage({ section }: { section: string }) {
  const { id } = useParams()
  const qc = useQueryClient(); const toast = useToast()
  const [search, setSearch] = useState(''); const [page, setPage] = useState(0)
  const [filter, setFilter] = useState('ALL')
  const [roleUser, setRoleUser] = useState<string | null>(null)
  const exportController = useRef<AbortController | null>(null)
  const [exportCount, setExportCount] = useState<number | null>(null)
  const [exportError, setExportError] = useState('')
  useEffect(() => () => exportController.current?.abort(), [])
  const [from, setFrom] = useState(() => new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10))
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10))
  const [edit, setEdit] = useState<{ action: string; data: RecordData } | null>(null)
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [reason, setReason] = useState('')
  const query = useQuery({ queryKey: ['platform', section, search, page, from, to, id, filter], queryFn: () => readPlatform(section, search, page, from, to, id, filter) })
  const options = useQuery({ queryKey: ['platform', 'options'], enabled: edit?.action === 'subscription.save', queryFn: () => readPlatform('options') })
  const assignees = useQuery({ queryKey: ['platform', 'assignees'], enabled: section === 'tickets' || section === 'ticket', queryFn: () => readPlatform('assignees') })
  useEffect(() => {
    if (!edit) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [edit])
  const open = (action: string, data: RecordData = {}) => { setError(''); setReason(''); setEdit({ action, data: { ...data } }) }
  const close = () => { if (!busy && window.confirm('Discard these unsaved changes?')) setEdit(null) }
  const title = sections[section]?.title ?? ({ revenue: 'Revenue', overview: 'Platform overview', organization: 'Organization details', settings: 'General settings', ticket: 'Ticket details' }[section] ?? section)
  const rows = query.data?.rows ?? []
  return <div className="space-y-6">
    {roleUser && <UserRoleEditor user={roleUser} onClose={() => setRoleUser(null)} />}
    <PageHeader title={title} description="Platform management • Live database records" />
    {query.data && section === 'revenue' && <RevenueSummary data={query.data} />}
    {['subscriptions', 'plans'].includes(section) && <p className="rounded-lg border border-slate-200 p-3 text-sm">Assigned plans limit active users, branches and warehouses. Organizations without an assigned plan retain their existing access. Payment collection remains unconfigured.</p>}
    {['invoices', 'payments'].includes(section) && <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Payment collection is unconfigured. Invoices are internal records; no payment is marked successful by this console.</p>}
    <div className="flex flex-wrap items-end gap-3">
      {['organizations', 'users', 'tickets', 'audit'].includes(section) && <Field label="Search"><Input value={search} onChange={e => { setSearch(e.target.value); setPage(0) }} placeholder="Search records" /></Field>}
      {section === 'organizations' && <Field label="Status"><select className="rounded border p-2" value={filter} onChange={e => { setFilter(e.target.value); setPage(0) }}>{['ALL', 'ACTIVE', 'SUSPENDED', 'ARCHIVED'].map(v => <option key={v}>{v}</option>)}</select></Field>}
      {section === 'onboarding' && <Field label="Status"><select className="rounded border p-2" value={filter} onChange={e => { setFilter(e.target.value); setPage(0) }}>{['ALL', 'PENDING', 'FAILED', 'COMPLETED', 'REJECTED'].map(v => <option key={v}>{v}</option>)}</select></Field>}
      {['overview', 'audit', 'notifications'].includes(section) && <><Field label="From"><Input type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field><Field label="To"><Input type="date" value={to} onChange={e => setTo(e.target.value)} /></Field></>}
      <Button variant="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh</Button>
      {rows.length > 0 && <Button variant="secondary" onClick={() => exportRecords(rows, section)}>Export current page</Button>}
      {sections[section] && rows.length > 0 && <Button variant="secondary" disabled={exportCount !== null} onClick={async () => {
        const controller = new AbortController(); exportController.current = controller; setExportCount(0); setExportError('')
        try {
          const records = await collectPlatformExport(section, search, from, to, id, filter, controller.signal, setExportCount)
          exportRecords(records, `${section}-all`)
        } catch (err) { if (!controller.signal.aborted) setExportError(err instanceof Error ? err.message : 'Export failed') }
        finally { if (exportController.current === controller) { exportController.current = null; setExportCount(null) } }
      }}>Export all matching records</Button>}
      {exportCount !== null && <><span role="status">Preparing {exportCount} records…</span><Button variant="secondary" onClick={() => exportController.current?.abort()}>Cancel export</Button></>}
      {sections[section]?.create && <Button onClick={() => open(sections[section]!.create!)}>Create</Button>}
      {section === 'organizations' && <Link className="rounded-lg bg-emerald-700 px-4 py-2 text-white" to="/platform/create">Create organization</Link>}
    </div>
    {query.isPending && <p role="status">Loading records…</p>}
    <InlineError message={exportError || null} />
    <InlineError message={query.isError ? String(query.error.message) : null} />
    {query.data && section === 'overview' && <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">{[['organizations', 'Total organizations', 'organizations'], ['active', 'Active organizations', 'organizations'], ['suspended', 'Suspended organizations', 'organizations'], ['users', 'Total users', 'users'], ['subscriptions', 'Active subscriptions', 'subscriptions']].map(([key, label, link]) => <Link key={key} to={`/platform/${link}`} className="rounded-xl border bg-white p-5 shadow-sm"><p className="text-sm text-slate-500">{label}</p><p className="mt-3 text-3xl font-semibold">{textValue(query.data![key!])}</p></Link>)}</div>
      <div className="grid gap-5 lg:grid-cols-2">{[['growth', 'New organizations by month', 'organizations'], ['user_growth', 'New users by month', 'users'], ['countries', 'Organizations by country', 'organizations']].map(([key, label, measure]) => <section key={key} className="rounded-xl border bg-white p-5"><h2 className="mb-5 font-semibold">{label}</h2><Growth rows={(query.data![key!] ?? []) as RecordData[]} measure={measure!} /></section>)}</div>
    </>}
    {query.data && section === 'settings' && <section className="rounded-xl border bg-white p-5"><Details data={query.data} /><Button onClick={() => open('settings.save', query.data!)}>Edit settings</Button></section>}
    {query.data && section === 'organization' && <OrganizationDetail key={id} data={query.data} onEdit={profile => open('organization.update', profile)} />}
    {query.data && section === 'ticket' && <section className="space-y-4 rounded-xl border bg-white p-5"><Details data={query.data.ticket as RecordData ?? {}} /><Button onClick={() => open('ticket.reply', { id })}>Add internal note</Button>{(query.data.ticket as RecordData)?.tenant_visible === true && <Button onClick={() => open('ticket.tenant_reply', { id })}>Reply to organization</Button>}{((query.data.replies ?? []) as RecordData[]).map(r => <article key={textValue(r.id)} className="border-t py-4"><p>{textValue(r.body)}</p><small>{textValue(r.created_at)}</small></article>)}</section>}
    {sections[section] && <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm"><thead className="bg-slate-50"><tr>{sections[section]!.columns.map(c => <th key={c} className="whitespace-nowrap p-3 font-medium capitalize">{c.replaceAll('_', ' ')}</th>)}<th className="p-3">Actions</th></tr></thead><tbody>{rows.map((row, i) => <tr key={textValue(row.id ?? row.organization_id) || i} className="border-t">{sections[section]!.columns.map(c => <td key={c} className="max-w-xs break-words p-3">{typeof row[c] === 'boolean' ? row[c] ? 'Yes' : 'No' : (c === 'assigned_to' ? textValue(assignees.data?.rows.find(a => a.id === row[c])?.email ?? row[c]) : textValue(row[c])) || '—'}</td>)}<td className="p-3"><div className="flex flex-wrap gap-2">
      {section === 'organizations' && <><Link className="text-emerald-700 underline" to={`/platform/organizations/${textValue(row.id)}`}>View</Link>{!row.archived_at && <><Button variant="secondary" onClick={() => open(row.is_active ? 'organization.suspend' : 'organization.reactivate', row)}>{row.is_active ? 'Suspend' : 'Reactivate'}</Button><Button variant="secondary" onClick={() => open('organization.archive', row)}>Archive</Button></>}</>}
      {section === 'users' && <Button variant="secondary" onClick={() => open(row.is_active ? 'user.deactivate' : 'user.activate', row)}>{row.is_active ? 'Deactivate' : 'Activate'}</Button>}
      {section === 'plans' && <Button variant="secondary" onClick={() => open('plan.save', row)}>Edit</Button>}
      {section === 'users' && <Button variant="secondary" onClick={() => setRoleUser(textValue(row.id))}>Roles</Button>}
      {section === 'invoices' && row.status === 'OPEN' && <Button variant="secondary" onClick={() => open('invoice.void', row)}>Void invoice</Button>}
      {section === 'announcements' && <Button variant="secondary" onClick={() => open(row.tenant_visible ? 'announcement.withdraw' : 'announcement.publish', row)}>{row.tenant_visible ? 'Withdraw from tenants' : 'Publish to all tenants'}</Button>}
      {section === 'onboarding' && <>{['PENDING', 'FAILED'].includes(textValue(row.status)) && <><Button onClick={() => open('onboarding.approve', row)}>{row.status === 'FAILED' ? 'Retry approval' : 'Approve'}</Button><Button variant="secondary" onClick={() => open('onboarding.reject', row)}>Reject</Button></>}{row.organization_id && <Link to={`/platform/organizations/${textValue(row.organization_id)}`}>View organization</Link>}</>}
      {section === 'operators' && <Button variant="secondary" onClick={() => open('operator.save', row)}>Edit access</Button>}
      {section === 'subscriptions' && <><Button variant="secondary" onClick={() => open('subscription.save', row)}>Change</Button><Button variant="secondary" onClick={() => open('invoice.create', row)}>Issue invoice</Button>{row.status === 'ACTIVE' && <Button variant="secondary" onClick={() => open('subscription.renew', row)}>Renew next period</Button>}</>}
      {section === 'tickets' && <><Link to={`/platform/tickets/${textValue(row.id)}`} className="text-emerald-700 underline">View</Link><Button variant="secondary" onClick={() => open('ticket.update', row)}>Update</Button></>}
      {section === 'notifications' && !row.is_read && <Button variant="secondary" onClick={() => open('notification.read', row)}>Mark read</Button>}
    </div></td></tr>)}</tbody></table>{!query.isPending && !rows.length && <p className="p-6 text-slate-500">No records found.</p>}</div>}
    {sections[section] && <div className="flex items-center gap-3"><Button variant="secondary" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</Button><span>Page {page + 1} · {query.data?.total ?? 0} records</span><Button variant="secondary" disabled={(page + 1) * 25 >= (query.data?.total ?? 0)} onClick={() => setPage(p => p + 1)}>Next</Button></div>}
    <Modal open={!!edit} title={edit?.action.replaceAll('.', ' · ') ?? ''} onClose={close}><form className="space-y-4" onSubmit={async e => {
      e.preventDefault(); if (!edit || busy) return; setBusy(true); setError('')
      try { await writePlatform(edit.action, edit.data, reason); setEdit(null); toast.success('Saved successfully'); await qc.invalidateQueries({ queryKey: ['platform'] }) }
      catch (err) { setError(err instanceof Error ? err.message : 'Could not save changes'); await qc.invalidateQueries({ queryKey: ['platform'] }) } finally { setBusy(false) }
    }}><InlineError message={error || null} />
      {edit && (formFields[edit.action] ?? []).map(field => <Field key={field.key} label={field.label}><>{['organization_id', 'plan_id'].includes(field.key) ? <select required className="w-full rounded border p-2" value={textValue(edit.data[field.key])} onChange={e => setEdit({ ...edit, data: { ...edit.data, [field.key]: e.target.value } })}><option value="">Select…</option>{((options.data?.[field.key === 'plan_id' ? 'plans' : 'organizations'] ?? []) as RecordData[]).map(o => <option key={textValue(o.id)} value={textValue(o.id)}>{textValue(o.name)}</option>)}</select> : field.options ? <select required className="w-full rounded border p-2" value={textValue(edit.data[field.key])} onChange={e => setEdit({ ...edit, data: { ...edit.data, [field.key]: e.target.value } })}><option value="">Select…</option>{field.options.map(o => <option key={o}>{o}</option>)}</select> : <Input required={!['email', 'phone', 'address', 'support_email', 'support_phone'].includes(field.key)} type={field.type ?? 'text'} step={field.type === 'number' ? '0.01' : undefined} value={textValue(edit.data[field.key])} onChange={e => setEdit({ ...edit, data: { ...edit.data, [field.key]: e.target.value } })} />}</></Field>)}
      {options.isError && edit?.action === 'subscription.save' && <InlineError message={options.error.message} />}
      {edit?.action === 'ticket.update' && <><Field label="Assigned administrator"><select className="w-full rounded border p-2" value={textValue(edit.data.assigned_to)} onChange={e => setEdit({ ...edit, data: { ...edit.data, assigned_to: e.target.value || null } })}><option value="">Unassigned</option>{edit.data.assigned_to && !assignees.data?.rows.some(a => a.id === edit.data.assigned_to) && <option value={textValue(edit.data.assigned_to)}>Current assignee (unavailable)</option>}{assignees.data?.rows.map(a => <option key={textValue(a.id)} value={textValue(a.id)}>{textValue(a.email)}</option>)}</select></Field><InlineError message={assignees.isError ? assignees.error.message : null} /></>}
      {edit?.action === 'subscription.renew' && <p>Advance the subscription after {textValue(edit.data.ends_on)} by one billing cycle and issue an unpaid invoice at the agreed price. No payment will be collected.</p>}{edit && !formFields[edit.action] && edit.action !== 'subscription.renew' && <p>Confirm {edit.action} for {textValue(edit.data.name ?? edit.data.id)}. This changes access immediately.</p>}
      {edit?.action === 'operator.save' && <fieldset className="space-y-2"><legend>Platform permissions</legend>{['overview', 'organizations', 'users', 'billing', 'support', 'settings', 'audit', 'operators'].map(permission => <label key={permission} className="flex items-center gap-2"><input type="checkbox" checked={(edit.data.permissions as string[] ?? []).includes(permission)} onChange={e => setEdit({ ...edit, data: { ...edit.data, permissions: e.target.checked ? [...(edit.data.permissions as string[] ?? []), permission] : (edit.data.permissions as string[] ?? []).filter(p => p !== permission) } })} />{permission}</label>)}</fieldset>}
      {edit && ['operator.save', 'plan.save'].includes(edit.action) && <label className="flex gap-2"><input type="checkbox" checked={edit.data.is_active !== false} onChange={e => setEdit({ ...edit, data: { ...edit.data, is_active: e.target.checked } })} />Active</label>}
      <Field label="Reason for this action"><Input required minLength={3} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></Field><div className="flex gap-3"><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Confirm and save'}</Button><Button variant="secondary" disabled={busy} onClick={close}>Cancel</Button></div>
    </form></Modal>
  </div>
}
function Details({ data }: { data: RecordData }) { return <dl className="mb-5 grid gap-3 sm:grid-cols-2">{Object.entries(data).map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-xs capitalize text-slate-500">{k.replaceAll('_', ' ')}</dt><dd className="break-words text-sm">{textValue(v) || '—'}</dd></div>)}</dl> }
function Growth({ rows, measure }: { rows: RecordData[]; measure: string }) {
  const max = Math.max(1, ...rows.map(r => Number(r[measure])))
  return rows.length ? <div className="space-y-3">{rows.map((r, i) => <div key={i}><div className="flex justify-between text-sm"><span>{textValue(r.month ?? r.country)}</span><span>{textValue(r[measure])}</span></div><div className="mt-1 h-3 rounded bg-slate-100"><div className="h-3 rounded bg-emerald-600" style={{ width: `${Number(r[measure]) / max * 100}%` }} /></div></div>)}</div> : <p className="text-sm text-slate-500">No records in this period.</p>
}
