import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, CardBody, Field, Input, InlineError, PageHeader } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/services/common'
import { toAppError } from '@/lib/errors'

export function TenantsPage() {
  const access = useQuery({ queryKey: ['platform-access'], queryFn: async () => unwrap(await supabase.rpc('platform_operator_access'), 'platform.access') })
  if (access.isPending) return <p>Checking platform access...</p>
  if (access.isError) return <InlineError message={toAppError(access.error).message} />
  if (!access.data) return <p>Platform operator access is required. Organization roles do not grant this access.</p>
  return <TenantConsole />
}
function TenantConsole() {
  const qc = useQueryClient()
  const [page, setPage] = useState(0)
  const [requestId, setRequestId] = useState<string>(() => crypto.randomUUID())
  const [values, setValues] = useState({ owner: '', first: '', last: '', name: '', currency: 'GHS', country: 'GH', timezone: 'Africa/Accra' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<string | null>(null)
  const tenants = useQuery({ queryKey: ['platform-tenants', page], queryFn: async () => unwrap(await supabase.rpc('platform_tenants', { p_page: page }), 'platform.tenants') })
  const labels = { owner: 'Verified owner Auth user ID', first: 'Owner first name', last: 'Owner last name', name: 'Organization name', currency: 'Currency code', country: 'Country code', timezone: 'Timezone' }
  return <div className="space-y-4 min-w-0">
    <PageHeader title="Tenant administration" description="Create separate organizations with their own head office and owner. Owners must first verify their authentication account." />
    <InlineError message={error ?? (tenants.isError ? toAppError(tenants.error).message : null)} />
    <Card><CardBody><form className="space-y-3" onSubmit={e => {
      e.preventDefault(); if (busy || created) return
      setBusy(true); setError(null)
      void (async () => { try {
        const id = unwrap(await supabase.rpc('onboard_tenant', { p_request_id: requestId, p_owner_user_id: values.owner, p_first_name: values.first, p_last_name: values.last, p_name: values.name, p_currency: values.currency, p_country: values.country, p_timezone: values.timezone }), 'platform.create')
        setCreated(id); setPage(0); await qc.invalidateQueries({ queryKey: ['platform-tenants'] })
      } catch (err) { setError(toAppError(err).message) } finally { setBusy(false) } })()
    }}>
      <Field label="Onboarding request ID (retain for retries)"><Input required value={requestId} disabled={busy || !!created} onChange={e => setRequestId(e.target.value)} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">{(Object.keys(labels) as (keyof typeof labels)[]).map(key => <Field key={key} label={labels[key]}><Input required maxLength={key === 'name' ? 200 : 100} value={values[key]} disabled={busy || !!created} onChange={e => setValues({ ...values, [key]: e.target.value })} /></Field>)}</div>
      <Button disabled={busy || !!created}>Create tenant</Button>
      {created && <div role="status"><p className="break-words">Tenant created: {created}. The owner can sign in and configure their organization.</p><Button type="button" variant="secondary" onClick={() => { setCreated(null); setRequestId(crypto.randomUUID()); setValues({ ...values, owner: '', first: '', last: '', name: '' }) }}>Create another tenant</Button></div>}
    </form></CardBody></Card>
    {tenants.isPending ? <p>Loading tenants...</p> : tenants.data?.map(t => <Card key={t.id}><CardBody><h2>{t.name}</h2><p>{t.country} / {t.currency_code} / {t.is_active ? 'Active' : 'Inactive'}</p><p className="break-words">{t.id}</p></CardBody></Card>)}
    <div className="flex gap-3"><Button disabled={!page || tenants.isFetching} onClick={() => setPage(page - 1)}>Previous</Button><span>Page {page + 1}</span><Button disabled={tenants.isFetching || tenants.data?.length !== 25} onClick={() => setPage(page + 1)}>Next</Button></div>
  </div>
}
