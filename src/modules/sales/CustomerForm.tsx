import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Button, Checkbox, DateInput, Field, InlineError, Input, Modal, Select, Textarea, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { entityCode, optionalText, requiredText, validate } from '@/lib/validation'
import { CUSTOMER_TYPES, CUSTOMER_TYPE_LABEL, MEDICINE_BUYERS, createCustomer, updateCustomer, type Customer, type CustomerType } from '@/services/customers'
import { listPriceLists } from '@/services/pricing'
import { useAppSettings } from '@/modules/settings/useAppSettings'

const iso2 = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a 2-letter code, e.g. GH').or(z.literal('')).optional().transform((v) => v || undefined)

const schema = z
  .object({
    code: entityCode,
    name: requiredText('Name', 200),
    customer_type: z.enum(CUSTOMER_TYPES),
    licence_number: optionalText(60),
    licence_expiry: z.string().optional().transform((v) => v || undefined),
    registered_pharmacist: optionalText(120),
    controlled_drugs_authorised: z.boolean(),
    tax_number: optionalText(60),
    contact_name: optionalText(120),
    phone: optionalText(40),
    email: z.string().trim().email('Enter a valid email').max(254).or(z.literal('')).optional().transform((v) => v || undefined),
    address: optionalText(300),
    city: optionalText(100),
    region: optionalText(100),
    country: iso2,
    payment_terms_days: z.coerce.number({ message: 'Enter a number' }).int('Whole days only').min(0, 'Cannot be negative').max(365, 'At most 365 days'),
    credit_limit: z.coerce.number({ message: 'Enter an amount' }).min(0, 'Cannot be negative').max(999_999_999_999, 'Too large'),
    price_list_id: z.string().uuid().or(z.literal('')).transform((v) => v || null),
    min_shelf_life_days: z.coerce.number({ message: 'Enter a number' }).int('Whole days only').min(0, 'Cannot be negative').max(3650, 'At most 3650 days'),
    on_hold: z.boolean(),
    hold_reason: optionalText(300),
    notes: optionalText(2000),
    is_active: z.boolean(),
  })
  .refine((v) => !v.on_hold || Boolean(v.hold_reason), { path: ['hold_reason'], message: 'Say why the customer is on hold.' })

type Values = Record<'code' | 'name' | 'customer_type' | 'licence_number' | 'licence_expiry' | 'registered_pharmacist' | 'tax_number' | 'contact_name' | 'phone' | 'email' |
  'address' | 'city' | 'region' | 'country' | 'payment_terms_days' | 'credit_limit' | 'price_list_id' | 'min_shelf_life_days' | 'hold_reason' | 'notes', string> &
  { controlled_drugs_authorised: boolean; on_hold: boolean; is_active: boolean }

const blank: Values = {
  code: '', name: '', customer_type: 'PHARMACY', licence_number: '', licence_expiry: '', registered_pharmacist: '', tax_number: '', contact_name: '', phone: '', email: '',
  address: '', city: '', region: '', country: 'GH', payment_terms_days: '0', credit_limit: '0', price_list_id: '', min_shelf_life_days: '0', hold_reason: '', notes: '',
  controlled_drugs_authorised: false, on_hold: false, is_active: true,
}
const fromCustomer = (c: Customer): Values => ({
  code: c.code, name: c.name, customer_type: c.customer_type, licence_number: c.licence_number ?? '', licence_expiry: c.licence_expiry ?? '',
  registered_pharmacist: c.registered_pharmacist ?? '', tax_number: c.tax_number ?? '', contact_name: c.contact_name ?? '', phone: c.phone ?? '', email: c.email ?? '',
  address: c.address ?? '', city: c.city ?? '', region: c.region ?? '', country: c.country ?? '', payment_terms_days: String(c.payment_terms_days),
  credit_limit: String(Number(c.credit_limit)), price_list_id: c.price_list_id ?? '', min_shelf_life_days: String(c.min_shelf_life_days), hold_reason: c.hold_reason ?? '',
  notes: c.notes ?? '', controlled_drugs_authorised: c.controlled_drugs_authorised, on_hold: c.on_hold, is_active: c.is_active,
})

export function CustomerForm({ open, customer, canEdit, onClose, onSaved }: {
  open: boolean; customer: Customer | null; canEdit: boolean; onClose: () => void; onSaved?: (id: string) => void
}) {
  return open ? <Inner customer={customer} canEdit={canEdit} onClose={onClose} {...(onSaved ? { onSaved } : {})} /> : null
}

function Inner({ customer, canEdit, onClose, onSaved }: { customer: Customer | null; canEdit: boolean; onClose: () => void; onSaved?: (id: string) => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const lists = useQuery({ queryKey: ['price-lists'], queryFn: listPriceLists, staleTime: 60_000 })
  const defaults = useAppSettings()
  const [values, setValues] = useState<Values>(customer ? fromCustomer(customer) : { ...blank, payment_terms_days: String(defaults.defaultCustomerTerms), credit_limit: String(defaults.defaultCreditLimit) })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: async (v: z.output<typeof schema>) => {
      if (customer) { await updateCustomer(customer.id, v); return customer.id }
      return createCustomer(v)
    },
    onSuccess: async (id) => {
      toast.success(customer ? 'Customer updated.' : 'Customer created.')
      await Promise.all(['customers', 'customer-options', 'customer'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
      onSaved?.(id)
      onClose()
    },
    onError: (e) => setServerError(toAppError(e).message),
  })

  const set = (k: keyof Values) => (e: { target: { value: string } }) => setValues({ ...values, [k]: e.target.value })
  function submit(e: FormEvent) {
    e.preventDefault()
    setServerError(null)
    const r = validate(schema, values)
    if (!r.ok) { setErrors(r.errors); return }
    setErrors({})
    save.mutate(r.data)
  }

  const ro = !canEdit
  const buysMedicines = MEDICINE_BUYERS.includes(values.customer_type as CustomerType)
  const formId = 'customer-form'
  return (
    <Modal
      open variant="drawer" title={customer ? (canEdit ? 'Edit customer' : 'Customer details') : 'New customer'} onClose={onClose}
      description="Licence, credit terms and holds decide what this customer may buy and on what terms."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{canEdit ? 'Cancel' : 'Close'}</Button>
          {canEdit && <Button type="submit" form={formId} loading={save.isPending}>{customer ? 'Save changes' : 'Create customer'}</Button>}
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        <InlineError message={serverError} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Code" required error={errors.code} hint="Unique, e.g. KORLE"><Input value={values.code} onChange={set('code')} maxLength={32} readOnly={ro || Boolean(customer)} /></Field>
          <Field label="Type" required error={errors.customer_type}>
            <Select value={values.customer_type} onChange={set('customer_type')} disabled={ro}>
              {CUSTOMER_TYPES.map((t) => <option key={t} value={t}>{CUSTOMER_TYPE_LABEL[t]}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Name" required error={errors.name}><Input value={values.name} onChange={set('name')} readOnly={ro} /></Field>

        <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Licence (needed to buy medicines)</legend>
          {!buysMedicines && <p className="text-xs text-amber-700">This type of customer can only buy general goods; prescription-only and pharmacy-only medicines are blocked for them.</p>}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Premises licence no." error={errors.licence_number}><Input value={values.licence_number} onChange={set('licence_number')} readOnly={ro} /></Field>
            <Field label="Licence expiry" error={errors.licence_expiry}><DateInput value={values.licence_expiry} onChange={set('licence_expiry')} readOnly={ro} /></Field>
          </div>
          <Field label="Registered pharmacist" error={errors.registered_pharmacist}><Input value={values.registered_pharmacist} onChange={set('registered_pharmacist')} readOnly={ro} /></Field>
          <Checkbox label="Authorised to buy controlled drugs" checked={values.controlled_drugs_authorised} disabled={ro} onChange={(e) => setValues({ ...values, controlled_drugs_authorised: e.target.checked })} />
        </fieldset>

        <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Credit and pricing</legend>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Payment terms (days)" required error={errors.payment_terms_days} hint="Days to pay after the invoice"><Input type="number" inputMode="numeric" min={0} max={365} value={values.payment_terms_days} onChange={set('payment_terms_days')} readOnly={ro} /></Field>
            <Field label="Credit limit" required error={errors.credit_limit} hint="0 = no credit: pay when buying"><Input type="number" inputMode="decimal" min={0} step="0.01" value={values.credit_limit} onChange={set('credit_limit')} readOnly={ro} /></Field>
            <Field label="Price list" error={errors.price_list_id} hint="Blank = the default list">
              <Select value={values.price_list_id} onChange={set('price_list_id')} disabled={ro}>
                <option value="">Default list</option>
                {(lists.data ?? []).filter((l) => l.is_active || l.id === values.price_list_id).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </Field>
            <Field label="Minimum shelf life (days)" error={errors.min_shelf_life_days} hint="Will not accept batches expiring sooner"><Input type="number" inputMode="numeric" min={0} max={3650} value={values.min_shelf_life_days} onChange={set('min_shelf_life_days')} readOnly={ro} /></Field>
          </div>
          <Checkbox label="On credit hold" checked={values.on_hold} disabled={ro} onChange={(e) => setValues({ ...values, on_hold: e.target.checked })} />
          {values.on_hold && <Field label="Why" required error={errors.hold_reason}><Input value={values.hold_reason} onChange={set('hold_reason')} maxLength={300} readOnly={ro} /></Field>}
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Contact person" error={errors.contact_name}><Input value={values.contact_name} onChange={set('contact_name')} readOnly={ro} /></Field>
          <Field label="Phone" error={errors.phone}><Input value={values.phone} onChange={set('phone')} readOnly={ro} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Email" error={errors.email}><Input type="email" value={values.email} onChange={set('email')} readOnly={ro} /></Field>
          <Field label="Tax number (TIN)" error={errors.tax_number}><Input value={values.tax_number} onChange={set('tax_number')} readOnly={ro} /></Field>
        </div>
        <Field label="Address" error={errors.address}><Input value={values.address} onChange={set('address')} readOnly={ro} /></Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="City" error={errors.city}><Input value={values.city} onChange={set('city')} readOnly={ro} /></Field>
          <Field label="Region" error={errors.region}><Input value={values.region} onChange={set('region')} readOnly={ro} /></Field>
          <Field label="Country" error={errors.country}><Input value={values.country} maxLength={2} onChange={set('country')} readOnly={ro} /></Field>
        </div>
        <Field label="Notes" error={errors.notes}><Textarea value={values.notes} onChange={set('notes')} readOnly={ro} /></Field>
        <Checkbox label="Active" checked={values.is_active} disabled={ro} onChange={(e) => setValues({ ...values, is_active: e.target.checked })} />
      </form>
    </Modal>
  )
}
