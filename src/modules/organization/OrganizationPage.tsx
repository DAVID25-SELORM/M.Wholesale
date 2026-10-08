import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Button, Card, CardBody, CardHeader, ErrorState, Field, InlineError, Input, LoadingState, PageHeader, Select, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { optionalText, requiredText, validate } from '@/lib/validation'
import { SESSION_QUERY_KEY, useSession } from '@/modules/session/SessionProvider'
import { getOrganization, updateOrganization, type Organization } from '@/services/organization'

const schema = z.object({
  name: requiredText('Name'),
  legal_name: optionalText(),
  trading_name: optionalText(),
  registration_number: optionalText(60),
  tax_number: optionalText(60),
  phone: optionalText(40),
  email: z.string().trim().email('Enter a valid email').or(z.literal('')).optional().transform((v) => v || undefined),
  address: optionalText(),
  city: optionalText(100),
  region: optionalText(100),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a 2-letter country code, e.g. GH'),
  currency_code: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code, e.g. GHS'),
  timezone: requiredText('Time zone', 64),
})

type FormValues = Record<keyof z.input<typeof schema>, string>

const toForm = (o: Organization): FormValues => ({
  name: o.name, legal_name: o.legal_name ?? '', trading_name: o.trading_name ?? '',
  registration_number: o.registration_number ?? '', tax_number: o.tax_number ?? '', phone: o.phone ?? '',
  email: o.email ?? '', address: o.address ?? '', city: o.city ?? '', region: o.region ?? '',
  country: o.country, currency_code: o.currency_code, timezone: o.timezone,
})

const TIMEZONES = (() => {
  try { return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone') } catch { return ['Africa/Accra'] }
})()

export function OrganizationPage() {
  const { ability } = useSession()
  const canEdit = ability.can('organizations.manage')
  const toast = useToast()
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ['organization'], queryFn: getOrganization })
  const [form, setForm] = useState<FormValues | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)

  // initialise the editable copy once, when the data first arrives (adjust state while rendering)
  if (query.data && form === null) setForm(toForm(query.data))

  const save = useMutation({
    mutationFn: (values: z.output<typeof schema>) => updateOrganization(query.data!.id, values),
    onSuccess: async () => {
      toast.success('Organization updated.')
      await Promise.all([qc.invalidateQueries({ queryKey: ['organization'] }), qc.invalidateQueries({ queryKey: SESSION_QUERY_KEY })])
    },
    onError: (e) => setServerError(toAppError(e).message),
  })

  if (query.isPending) return <LoadingState />
  if (query.isError || !form) return <ErrorState message={toAppError(query.error).message} onRetry={() => void query.refetch()} />

  const set = (k: keyof FormValues) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setServerError(null)
    const r = validate(schema, form)
    if (!r.ok) { setErrors(r.errors); return }
    setErrors({})
    save.mutate(r.data)
  }

  const ro = !canEdit
  return (
    <>
      <PageHeader title="Organization" description={canEdit ? 'Company information used across the ERP.' : 'You can view, but not change, the company profile.'} />
      <form onSubmit={onSubmit} noValidate>
        <Card>
          <CardHeader title="Company profile" />
          <CardBody className="space-y-4">
            <InlineError message={serverError} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" required error={errors.name}><Input value={form.name} onChange={set('name')} readOnly={ro} /></Field>
              <Field label="Legal name" error={errors.legal_name}><Input value={form.legal_name} onChange={set('legal_name')} readOnly={ro} /></Field>
              <Field label="Trading name" error={errors.trading_name}><Input value={form.trading_name} onChange={set('trading_name')} readOnly={ro} /></Field>
              <Field label="Registration number" error={errors.registration_number}><Input value={form.registration_number} onChange={set('registration_number')} readOnly={ro} /></Field>
              <Field label="Tax number (TIN)" error={errors.tax_number}><Input value={form.tax_number} onChange={set('tax_number')} readOnly={ro} /></Field>
              <Field label="Phone" error={errors.phone}><Input value={form.phone} onChange={set('phone')} readOnly={ro} /></Field>
              <Field label="Email" error={errors.email}><Input type="email" value={form.email} onChange={set('email')} readOnly={ro} /></Field>
              <Field label="Address" error={errors.address}><Input value={form.address} onChange={set('address')} readOnly={ro} /></Field>
              <Field label="City" error={errors.city}><Input value={form.city} onChange={set('city')} readOnly={ro} /></Field>
              <Field label="Region" error={errors.region}><Input value={form.region} onChange={set('region')} readOnly={ro} /></Field>
              <Field label="Country (ISO code)" required error={errors.country}><Input value={form.country} onChange={set('country')} maxLength={2} readOnly={ro} /></Field>
              <Field label="Currency (ISO code)" required error={errors.currency_code} hint="Default for Ghana: GHS"><Input value={form.currency_code} onChange={set('currency_code')} maxLength={3} readOnly={ro} /></Field>
              <Field label="Time zone" required error={errors.timezone}>
                <Select value={form.timezone} onChange={set('timezone')} disabled={ro}>
                  {(TIMEZONES.includes(form.timezone) ? TIMEZONES : [form.timezone, ...TIMEZONES]).map((z) => <option key={z} value={z}>{z}</option>)}
                </Select>
              </Field>
            </div>
            {canEdit && (
              <div className="flex justify-end pt-2">
                <Button type="submit" loading={save.isPending}>Save changes</Button>
              </div>
            )}
          </CardBody>
        </Card>
      </form>
    </>
  )
}
