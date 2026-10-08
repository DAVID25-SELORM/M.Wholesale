import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Button, Checkbox, Field, InlineError, Input, Modal, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { entityCode, optionalText, requiredText, validate } from '@/lib/validation'
import { SESSION_QUERY_KEY } from '@/modules/session/SessionProvider'
import { createBranch, updateBranch, type Branch } from '@/services/branches'

export const branchSchema = z.object({
  code: entityCode,
  name: requiredText('Name'),
  phone: optionalText(40),
  email: z.string().trim().email('Enter a valid email').or(z.literal('')).optional().transform((v) => v || undefined),
  address: optionalText(),
  city: optionalText(100),
  region: optionalText(100),
  is_head_office: z.boolean(),
  is_active: z.boolean(),
})

interface Values {
  code: string; name: string; phone: string; email: string; address: string; city: string; region: string
  is_head_office: boolean; is_active: boolean
}

const blank: Values = { code: '', name: '', phone: '', email: '', address: '', city: '', region: '', is_head_office: false, is_active: true }
const fromBranch = (b: Branch): Values => ({
  code: b.code, name: b.name, phone: b.phone ?? '', email: b.email ?? '', address: b.address ?? '',
  city: b.city ?? '', region: b.region ?? '', is_head_office: b.is_head_office, is_active: b.is_active,
})

export function BranchForm({ open, branch, canEdit, onClose }: { open: boolean; branch: Branch | null; canEdit: boolean; onClose: () => void }) {
  return open ? <BranchFormInner branch={branch} canEdit={canEdit} onClose={onClose} /> : null
}

function BranchFormInner({ branch, canEdit, onClose }: { branch: Branch | null; canEdit: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [values, setValues] = useState<Values>(branch ? fromBranch(branch) : blank)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (v: z.output<typeof branchSchema>) => (branch ? updateBranch(branch.id, v) : createBranch(v)),
    onSuccess: async () => {
      toast.success(branch ? 'Branch updated.' : 'Branch created.')
      await Promise.all([qc.invalidateQueries({ queryKey: ['branches'] }), qc.invalidateQueries({ queryKey: SESSION_QUERY_KEY }), qc.invalidateQueries({ queryKey: ['dashboard'] })])
      onClose()
    },
    onError: (e) => setServerError(toAppError(e).message),
  })

  const set = (k: keyof Values) => (e: { target: { value: string } }) => setValues({ ...values, [k]: e.target.value })

  function submit(e: FormEvent) {
    e.preventDefault()
    setServerError(null)
    const r = validate(branchSchema, values)
    if (!r.ok) { setErrors(r.errors); return }
    setErrors({})
    save.mutate(r.data)
  }

  const formId = 'branch-form'
  return (
    <Modal
      open
      variant="drawer"
      title={branch ? (canEdit ? 'Edit branch' : 'Branch details') : 'New branch'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{canEdit ? 'Cancel' : 'Close'}</Button>
          {canEdit && <Button type="submit" form={formId} loading={save.isPending}>{branch ? 'Save changes' : 'Create branch'}</Button>}
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        <InlineError message={serverError} />
        <Field label="Code" required error={errors.code} hint="Unique within your organization, e.g. HQ, KUM">
          <Input value={values.code} onChange={set('code')} maxLength={32} readOnly={!canEdit} />
        </Field>
        <Field label="Name" required error={errors.name}><Input value={values.name} onChange={set('name')} readOnly={!canEdit} /></Field>
        <Field label="Phone" error={errors.phone}><Input value={values.phone} onChange={set('phone')} readOnly={!canEdit} /></Field>
        <Field label="Email" error={errors.email}><Input type="email" value={values.email} onChange={set('email')} readOnly={!canEdit} /></Field>
        <Field label="Address" error={errors.address}><Input value={values.address} onChange={set('address')} readOnly={!canEdit} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="City" error={errors.city}><Input value={values.city} onChange={set('city')} readOnly={!canEdit} /></Field>
          <Field label="Region" error={errors.region}><Input value={values.region} onChange={set('region')} readOnly={!canEdit} /></Field>
        </div>
        <Checkbox label="Head office" checked={values.is_head_office} disabled={!canEdit} onChange={(e) => setValues({ ...values, is_head_office: e.target.checked })} />
        <Checkbox label="Active" checked={values.is_active} disabled={!canEdit} onChange={(e) => setValues({ ...values, is_active: e.target.checked })} />
      </form>
    </Modal>
  )
}
