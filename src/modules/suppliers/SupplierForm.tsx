import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Button, Checkbox, DateInput, Field, InlineError, Input, Modal, Select, Textarea, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { entityCode, optionalText, requiredText, validate } from '@/lib/validation'
import { SUPPLIER_TYPES, createSupplier, updateSupplier, type Supplier, type SupplierType } from '@/services/suppliers'

export const SUPPLIER_TYPE_LABEL: Record<SupplierType, string> = {
  MANUFACTURER: 'Manufacturer', IMPORTER: 'Importer', DISTRIBUTOR: 'Distributor', WHOLESALER: 'Wholesaler', OTHER: 'Other',
}

const iso = (n: number, label: string) => z.string().trim().toUpperCase().regex(new RegExp(`^[A-Z]{${n}}$`), label).or(z.literal('')).optional().transform((v) => v || undefined)

const schema = z.object({
  code: entityCode,
  name: requiredText('Name', 200),
  supplier_type: z.enum(SUPPLIER_TYPES),
  registration_number: optionalText(60),
  tax_number: optionalText(60),
  licence_number: optionalText(60),
  licence_expiry: z.string().optional().transform((v) => v || undefined),
  payment_terms_days: z.coerce.number({ message: 'Enter a number' }).int('Whole days only').min(0, 'Cannot be negative').max(365, 'At most 365 days'),
  currency_code: iso(3, 'Use a 3-letter code, e.g. GHS'),
  contact_name: optionalText(120),
  phone: optionalText(40),
  email: z.string().trim().email('Enter a valid email').max(254).or(z.literal('')).optional().transform((v) => v || undefined),
  address: optionalText(300),
  city: optionalText(100),
  region: optionalText(100),
  country: iso(2, 'Use a 2-letter code, e.g. GH'),
  notes: optionalText(2000),
  is_active: z.boolean(),
})

type Values = Record<'code' | 'name' | 'supplier_type' | 'registration_number' | 'tax_number' | 'licence_number' | 'licence_expiry' | 'payment_terms_days' |
  'currency_code' | 'contact_name' | 'phone' | 'email' | 'address' | 'city' | 'region' | 'country' | 'notes', string> & { is_active: boolean }

const blank: Values = {
  code: '', name: '', supplier_type: 'DISTRIBUTOR', registration_number: '', tax_number: '', licence_number: '', licence_expiry: '', payment_terms_days: '30',
  currency_code: '', contact_name: '', phone: '', email: '', address: '', city: '', region: '', country: '', notes: '', is_active: true,
}
const fromSupplier = (s: Supplier): Values => ({
  code: s.code, name: s.name, supplier_type: s.supplier_type, registration_number: s.registration_number ?? '', tax_number: s.tax_number ?? '',
  licence_number: s.licence_number ?? '', licence_expiry: s.licence_expiry ?? '', payment_terms_days: String(s.payment_terms_days),
  currency_code: s.currency_code ?? '', contact_name: s.contact_name ?? '', phone: s.phone ?? '', email: s.email ?? '', address: s.address ?? '',
  city: s.city ?? '', region: s.region ?? '', country: s.country ?? '', notes: s.notes ?? '', is_active: s.is_active,
})

export function SupplierForm({ open, supplier, canEdit, onClose }: { open: boolean; supplier: Supplier | null; canEdit: boolean; onClose: () => void }) {
  return open ? <Inner supplier={supplier} canEdit={canEdit} onClose={onClose} /> : null
}

function Inner({ supplier, canEdit, onClose }: { supplier: Supplier | null; canEdit: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [values, setValues] = useState<Values>(supplier ? fromSupplier(supplier) : blank)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (v: z.output<typeof schema>) => (supplier ? updateSupplier(supplier.id, v) : createSupplier(v)),
    onSuccess: async () => {
      toast.success(supplier ? 'Supplier updated.' : 'Supplier created.')
      await qc.invalidateQueries({ queryKey: ['suppliers'] })
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
  const formId = 'supplier-form'
  return (
    <Modal
      open
      variant="drawer"
      title={supplier ? (canEdit ? 'Edit supplier' : 'Supplier details') : 'New supplier'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{canEdit ? 'Cancel' : 'Close'}</Button>
          {canEdit && <Button type="submit" form={formId} loading={save.isPending}>{supplier ? 'Save changes' : 'Create supplier'}</Button>}
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        <InlineError message={serverError} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Code" required error={errors.code} hint="Unique, e.g. EMP"><Input value={values.code} onChange={set('code')} maxLength={32} readOnly={ro} /></Field>
          <Field label="Type" required error={errors.supplier_type}>
            <Select value={values.supplier_type} onChange={set('supplier_type')} disabled={ro}>
              {SUPPLIER_TYPES.map((t) => <option key={t} value={t}>{SUPPLIER_TYPE_LABEL[t]}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Name" required error={errors.name}><Input value={values.name} onChange={set('name')} readOnly={ro} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Licence number" error={errors.licence_number} hint="FDA / Pharmacy Council"><Input value={values.licence_number} onChange={set('licence_number')} readOnly={ro} /></Field>
          <Field label="Licence expiry" error={errors.licence_expiry}><DateInput value={values.licence_expiry} onChange={set('licence_expiry')} readOnly={ro} /></Field>
          <Field label="Registration no." error={errors.registration_number}><Input value={values.registration_number} onChange={set('registration_number')} readOnly={ro} /></Field>
          <Field label="Tax number (TIN)" error={errors.tax_number}><Input value={values.tax_number} onChange={set('tax_number')} readOnly={ro} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Payment terms (days)" required error={errors.payment_terms_days}><Input type="number" inputMode="numeric" min={0} max={365} value={values.payment_terms_days} onChange={set('payment_terms_days')} readOnly={ro} /></Field>
          <Field label="Currency" error={errors.currency_code} hint="Blank = your organization's currency"><Input value={values.currency_code} maxLength={3} onChange={set('currency_code')} readOnly={ro} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Contact person" error={errors.contact_name}><Input value={values.contact_name} onChange={set('contact_name')} readOnly={ro} /></Field>
          <Field label="Phone" error={errors.phone}><Input value={values.phone} onChange={set('phone')} readOnly={ro} /></Field>
        </div>
        <Field label="Email" error={errors.email}><Input type="email" value={values.email} onChange={set('email')} readOnly={ro} /></Field>
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
