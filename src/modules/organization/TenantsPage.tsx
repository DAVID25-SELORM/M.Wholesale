import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Button, Card, CardBody, Field, Input, InlineError, PageHeader } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/services/common'
import { toAppError } from '@/lib/errors'
import { readPlatform, textValue } from '@/modules/platform/api'

export function TenantsPage() {
  const qc = useQueryClient()
  const [requestId, setRequestId] = useState<string>(() => crypto.randomUUID())
  const [step, setStep] = useState(0)
  const [values, setValues] = useState({ email: '', owner: '', first: '', last: '', name: '', currency: 'GHS', country: 'GH', timezone: 'Africa/Accra' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<string | null>(null)
  const labels = { first: 'Owner first name', last: 'Owner last name', name: 'Organization name', currency: 'Currency code', country: 'Country code', timezone: 'Timezone' }
  const fields = step === 0 ? ['name', 'currency', 'country', 'timezone'] as const : ['first', 'last'] as const
  return <div className="min-w-0 space-y-5">
    <PageHeader title="Create organization" description="Create an independent organization and head office for a verified owner." />
    <ol aria-label="Onboarding steps" className="flex flex-wrap gap-3">{['Organization', 'Verified owner', 'Review & create'].map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined} className={`rounded-full px-4 py-2 text-sm ${step === index ? 'bg-emerald-700 text-white' : 'bg-slate-200'}`}>{index + 1}. {label}</li>)}</ol>
    <InlineError message={error} />
    <Card><CardBody><form className="space-y-4" onSubmit={async e => {
      e.preventDefault(); if (busy || created) return
      if (step === 0) { setStep(1); return }
      setBusy(true); setError(null)
      try {
        if (step === 1) {
          const found = await readPlatform('owners', values.email)
          const owner = found.rows[0]
          if (!owner) throw new Error('No unassigned authentication account matches this email. The owner must first have an account in this Supabase project.')
          if (!owner.verified) throw new Error('The owner must verify their email before onboarding.')
          setValues(v => ({ ...v, owner: textValue(owner.id) })); setStep(2)
        } else {
          const id = unwrap(await supabase.rpc('onboard_tenant', { p_request_id: requestId, p_owner_user_id: values.owner, p_first_name: values.first, p_last_name: values.last, p_name: values.name, p_currency: values.currency, p_country: values.country, p_timezone: values.timezone }), 'platform.create')
          setCreated(id); await qc.invalidateQueries({ queryKey: ['platform'] })
        }
      } catch (err) { setError(toAppError(err).message) } finally { setBusy(false) }
    }}>
      {step < 2 ? <div className="grid gap-4 sm:grid-cols-2">{fields.map(key => <Field key={key} label={labels[key]}><Input required maxLength={key === 'name' ? 200 : 100} value={values[key]} disabled={busy} onChange={e => setValues({ ...values, [key]: e.target.value })} /></Field>)}{step === 1 && <Field label="Owner email"><Input required type="email" value={values.email} disabled={busy} onChange={e => setValues({ ...values, email: e.target.value, owner: '' })} /></Field>}</div> : <dl className="grid gap-4 sm:grid-cols-2">{Object.entries(values).filter(([key]) => key !== 'owner').map(([key, value]) => <div key={key}><dt className="text-sm capitalize text-slate-500">{key}</dt><dd className="break-words">{value}</dd></div>)}</dl>}
      <p className="text-xs text-slate-500">Request reference: {requestId}. Retries reuse this reference to prevent duplicate organizations.</p>
      <div className="flex gap-3">{step > 0 && !created && <Button type="button" variant="secondary" disabled={busy} onClick={() => setStep(step - 1)}>Back</Button>}<Button type="submit" disabled={busy || !!created}>{busy ? 'Working…' : step === 2 ? 'Confirm and create organization' : step === 1 ? 'Verify owner and review' : 'Next'}</Button></div>
      {created && <div role="status" className="space-y-3"><p>Organization created. The owner can now sign in.</p><Link className="text-emerald-700 underline" to={`/platform/organizations/${created}`}>View organization</Link><Button type="button" variant="secondary" onClick={() => { setCreated(null); setRequestId(crypto.randomUUID()); setStep(0); setValues({ ...values, owner: '', email: '', first: '', last: '', name: '' }) }}>Create another</Button></div>}
    </form></CardBody></Card>
  </div>
}
