import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Button, Checkbox, DateInput, Field, InlineError, Input, Modal, Select, Textarea, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { entityCode, optionalText, requiredText, validate } from '@/lib/validation'
import { useSession } from '@/modules/session/SessionProvider'
import { createDriver, updateDriver, type Driver } from '@/services/fleet'

export const driverSchema = z.object({
  branch_id: z.string().min(1, 'Choose a branch'),
  code: entityCode,
  name: requiredText('Name', 120),
  phone: optionalText(40),
  licence_number: optionalText(40),
  licence_class: optionalText(20),
  licence_expiry: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date').or(z.literal('')).optional().transform((v) => v || undefined),
  notes: optionalText(1000),
  is_active: z.boolean(),
})

interface Values { branch_id: string; code: string; name: string; phone: string; licence_number: string; licence_class: string; licence_expiry: string; notes: string; is_active: boolean }
const blank = (branch: string): Values => ({ branch_id: branch, code: '', name: '', phone: '', licence_number: '', licence_class: '', licence_expiry: '', notes: '', is_active: true })
const fromDriver = (d: Driver): Values => ({
  branch_id: d.branch_id, code: d.code, name: d.name, phone: d.phone ?? '', licence_number: d.licence_number ?? '', licence_class: d.licence_class ?? '',
  licence_expiry: d.licence_expiry ?? '', notes: d.notes ?? '', is_active: d.is_active,
})

export function DriverForm({ open, driver, canEdit, onClose }: { open: boolean; driver: Driver | null; canEdit: boolean; onClose: () => void }) {
  return open ? <DriverFormInner driver={driver} canEdit={canEdit} onClose={onClose} /> : null
}

function DriverFormInner({ driver, canEdit, onClose }: { driver: Driver | null; canEdit: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const { branches, ability, selectedBranch } = useSession()
  const choices = branches.filter((b) => b.is_active && ability.can('fleet.manage', b.id))
  const firstBranch = (selectedBranch !== 'ALL' && choices.some((b) => b.id === selectedBranch) ? selectedBranch : choices[0]?.id) ?? ''
  const [values, setValues] = useState<Values>(driver ? fromDriver(driver) : blank(firstBranch))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (v: z.output<typeof driverSchema>) => (driver ? updateDriver(driver.id, v) : createDriver(v)),
    onSuccess: async () => {
      toast.success(driver ? 'Driver updated.' : 'Driver created.')
      await qc.invalidateQueries({ queryKey: ['drivers'] })
      onClose()
    },
    onError: (e) => setServerError(toAppError(e).message),
  })

  const set = (k: keyof Values) => (e: { target: { value: string } }) => setValues({ ...values, [k]: e.target.value })
  function submit(e: FormEvent) {
    e.preventDefault()
    setServerError(null)
    const r = validate(driverSchema, values)
    if (!r.ok) { setErrors(r.errors); return }
    setErrors({})
    save.mutate(r.data)
  }

  const formId = 'driver-form'
  const ro = !canEdit
  return (
    <Modal
      open
      variant="drawer"
      title={driver ? (canEdit ? 'Edit driver' : 'Driver details') : 'New driver'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{canEdit ? 'Cancel' : 'Close'}</Button>
          {canEdit && <Button type="submit" form={formId} loading={save.isPending}>{driver ? 'Save changes' : 'Create driver'}</Button>}
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        <InlineError message={serverError} />
        <Field label="Code" required error={errors.code} hint="Unique within your organization, e.g. DRV-01">
          <Input value={values.code} onChange={set('code')} maxLength={32} readOnly={ro} />
        </Field>
        <Field label="Name" required error={errors.name}><Input value={values.name} onChange={set('name')} maxLength={120} readOnly={ro} /></Field>
        <Field label="Branch" required error={errors.branch_id}>
          <Select value={values.branch_id} onChange={set('branch_id')} disabled={ro}>
            {driver && !choices.some((b) => b.id === driver.branch_id) && <option value={driver.branch_id}>{branches.find((b) => b.id === driver.branch_id)?.name ?? 'Current branch'}</option>}
            {choices.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
        <Field label="Phone" error={errors.phone}><Input value={values.phone} onChange={set('phone')} maxLength={40} readOnly={ro} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Licence number" error={errors.licence_number}><Input value={values.licence_number} onChange={set('licence_number')} maxLength={40} readOnly={ro} /></Field>
          <Field label="Licence class" error={errors.licence_class}><Input value={values.licence_class} onChange={set('licence_class')} maxLength={20} readOnly={ro} /></Field>
        </div>
        <Field label="Licence expiry" error={errors.licence_expiry} hint="A driver with an expired licence cannot be put on a delivery run.">
          <DateInput value={values.licence_expiry} onChange={set('licence_expiry')} readOnly={ro} />
        </Field>
        <Field label="Notes" error={errors.notes}><Textarea value={values.notes} onChange={set('notes')} rows={3} maxLength={1000} readOnly={ro} /></Field>
        <Checkbox label="Active" checked={values.is_active} disabled={ro} onChange={(e) => setValues({ ...values, is_active: e.target.checked })} />
      </form>
    </Modal>
  )
}
