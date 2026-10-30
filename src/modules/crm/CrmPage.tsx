import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, CardBody, Field, Input, Select, Textarea, PageHeader, InlineError } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import { unwrap } from '@/services/common'

type Kind = 'territories' | 'representatives' | 'visits' | 'targets'
type Option = { id: string; label: string }
type Workspace = { rows: Record<string, string | boolean | number | null>[]; territories: Option[]; profiles: Option[]; customers: Option[]; representatives: Option[] }
type Definition = { name: string; label: string; type?: string; options?: keyof Omit<Workspace, 'rows'>; choices?: string[]; optional?: boolean }
const fields: Record<Kind, Definition[]> = {
  territories: [{ name: 'name', label: 'Territory name' }, { name: 'area', label: 'Area covered', type: 'textarea' }, { name: 'is_active', label: 'Active', type: 'boolean' }],
  representatives: [{ name: 'profile_id', label: 'Staff member', options: 'profiles' }, { name: 'territory_id', label: 'Territory', options: 'territories' }, { name: 'is_active', label: 'Active', type: 'boolean' }],
  visits: [{ name: 'representative_id', label: 'Representative', options: 'representatives' }, { name: 'customer_id', label: 'Customer', options: 'customers' }, { name: 'visit_date', label: 'Visit date', type: 'date' }, { name: 'outcome', label: 'Outcome', choices: ['COMPLETED', 'NO_CONTACT', 'FOLLOW_UP'] }, { name: 'notes', label: 'Visit notes', type: 'textarea' }, { name: 'follow_up_date', label: 'Follow-up date', type: 'date', optional: true }],
  targets: [{ name: 'representative_id', label: 'Representative', options: 'representatives' }, { name: 'period_start', label: 'Period start', type: 'date' }, { name: 'period_end', label: 'Period end', type: 'date' }, { name: 'sales_target', label: 'Sales target (organization currency)', type: 'number' }, { name: 'notes', label: 'Target notes', type: 'textarea', optional: true }],
}
const titles: Record<Kind, string> = { territories: 'Territories', representatives: 'Sales reps', visits: 'Visits', targets: 'Targets' }
export function CrmPage({ kind }: { kind: Kind }) { return <WorkspacePage key={kind} kind={kind} /> }
function WorkspacePage({ kind }: { kind: Kind }) {
  const { ability } = useSession()
  const qc = useQueryClient()
  const [page, setPage] = useState(0)
  const [editing, setEditing] = useState<string | null | undefined>(undefined)
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const query = useQuery({ queryKey: ['crm', kind, page], queryFn: async () => unwrap(await supabase.rpc('crm_workspace', { p_kind: kind, p_page: page }), 'crm.list') as unknown as Workspace })
  async function save() {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const data: Record<string, string | boolean | number> = { ...values }
      if (kind === 'territories' || kind === 'representatives') data.is_active = values.is_active !== 'false'
      if (kind === 'targets') data.sales_target = Number(values.sales_target)
      unwrap(await supabase.rpc('save_crm_record', { p_kind: kind, p_id: editing ?? null, p_data: data }), 'crm.save')
      await qc.invalidateQueries({ queryKey: ['crm'] }); setEditing(undefined)
    } catch (e) { setError(toAppError(e).message) } finally { setBusy(false) }
  }
  return <div className="space-y-4">
    <PageHeader title={titles[kind]} description={kind === 'targets' ? 'Record representative sales objectives. Actual sales attribution is not yet linked to these targets.' : 'Manage your organization’s customer relationship records.'} actions={ability.can('crm.manage') && <Button onClick={() => { setValues({ is_active: 'true' }); setEditing(null); setError(null) }}>New record</Button>} />
    <InlineError message={error ?? (query.isError ? toAppError(query.error).message : null)} />
    {query.isError && <Button onClick={() => void query.refetch()}>Retry</Button>}
    {editing !== undefined && <Card><CardBody><form className="grid gap-3 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); void save() }}>
      {fields[kind].map(f => <Field key={f.name} label={f.label}><Editor field={f} value={values[f.name] ?? ''} onChange={v => setValues({ ...values, [f.name]: v })} data={query.data} /></Field>)}
      <div className="flex flex-wrap gap-2 sm:col-span-2"><Button type="submit" disabled={busy || !query.data}>Save record</Button><Button type="button" variant="secondary" disabled={busy} onClick={() => setEditing(undefined)}>Cancel</Button></div>
    </form></CardBody></Card>}
    {query.isPending ? <p>Loading...</p> : query.data?.rows.length === 0 ? <p>No records on this page.</p> : query.data?.rows.map(r => <Card key={String(r.id)}><CardBody className="space-y-2">
      <dl className="grid gap-2 sm:grid-cols-2">{fields[kind].map(f => <div key={f.name}><dt className="text-sm text-slate-500">{f.label}</dt><dd className="whitespace-pre-wrap break-words">{f.options ? query.data?.[f.options].find(o => o.id === r[f.name])?.label ?? String(r[f.name] ?? 'Unavailable') : f.type === 'boolean' ? r[f.name] ? 'Yes' : 'No' : String(r[f.name] ?? '—')}</dd></div>)}</dl>
      {ability.can('crm.manage') && <Button variant="secondary" onClick={() => { setValues(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? '' : String(v)]))); setEditing(String(r.id)); setError(null) }}>Edit record</Button>}
    </CardBody></Card>)}
    <div className="flex gap-3"><Button disabled={!page || query.isFetching} onClick={() => setPage(page - 1)}>Previous</Button><span>Page {page + 1}</span><Button disabled={query.isFetching || query.data?.rows.length !== 25} onClick={() => setPage(page + 1)}>Next</Button></div>
  </div>
}
function Editor({ field: f, value, onChange, data, id }: { id?: string; field: Definition; value: string; onChange: (v: string) => void; data: Workspace | undefined }) {
  if (f.options || f.choices || f.type === 'boolean') return <Select id={id} required={!f.optional} value={value} onChange={e => onChange(e.target.value)}><option value="">Choose</option>{f.type === 'boolean' ? <><option value="true">Yes</option><option value="false">No</option></> : f.options ? data?.[f.options].map(o => <option key={o.id} value={o.id}>{o.label}</option>) : f.choices?.map(c => <option key={c}>{c}</option>)}</Select>
  if (f.type === 'textarea') return <Textarea id={id} required={!f.optional} maxLength={f.name === 'area' ? 1000 : 2000} value={value} onChange={e => onChange(e.target.value)} />
  return <Input id={id} required={!f.optional} type={f.type ?? 'text'} maxLength={120} min={f.type === 'number' ? '0.01' : undefined} step={f.type === 'number' ? '0.01' : undefined} value={value} onChange={e => onChange(e.target.value)} />
}
