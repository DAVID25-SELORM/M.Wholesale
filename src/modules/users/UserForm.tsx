import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Button, Field, InlineError, Input, Modal, Select, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { optionalText, requiredText, validate } from '@/lib/validation'
import { listBranchOptions } from '@/services/branches'
import { updateProfile, type UserRow } from '@/services/users'

const schema = z.object({
  first_name: requiredText('First name', 100),
  last_name: requiredText('Last name', 100),
  phone: optionalText(40),
  employee_code: optionalText(40),
  job_title: optionalText(100),
  default_branch_id: z.string().uuid().or(z.literal('')).transform((v) => v || null),
})

interface Values { first_name: string; last_name: string; phone: string; employee_code: string; job_title: string; default_branch_id: string }

export function UserForm({ user, canEditEmployeeFields, onClose }: { user: UserRow | null; canEditEmployeeFields: boolean; onClose: () => void }) {
  return user ? <Inner user={user} canEditEmployeeFields={canEditEmployeeFields} onClose={onClose} /> : null
}

function Inner({ user, canEditEmployeeFields, onClose }: { user: UserRow; canEditEmployeeFields: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const branches = useQuery({ queryKey: ['branches', 'options'], queryFn: listBranchOptions, staleTime: 60_000 })
  const [values, setValues] = useState<Values>({
    first_name: user.first_name, last_name: user.last_name, phone: user.phone ?? '', employee_code: user.employee_code ?? '',
    job_title: user.job_title ?? '', default_branch_id: user.default_branch_id ?? '',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (v: z.output<typeof schema>) => updateProfile(user.id, v, canEditEmployeeFields),
    onSuccess: async () => { toast.success('User updated.'); await qc.invalidateQueries({ queryKey: ['users'] }); onClose() },
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

  const formId = 'user-form'
  return (
    <Modal
      open
      variant="drawer"
      title="Edit user"
      description={user.email ?? undefined}
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form={formId} loading={save.isPending}>Save changes</Button></>}
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        <InlineError message={serverError} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name" required error={errors.first_name}><Input value={values.first_name} onChange={set('first_name')} /></Field>
          <Field label="Last name" required error={errors.last_name}><Input value={values.last_name} onChange={set('last_name')} /></Field>
        </div>
        <Field label="Phone" error={errors.phone}><Input value={values.phone} onChange={set('phone')} /></Field>
        <Field label="Employee code" error={errors.employee_code} hint={canEditEmployeeFields ? undefined : 'Only user administrators can change this.'}>
          <Input value={values.employee_code} onChange={set('employee_code')} readOnly={!canEditEmployeeFields} />
        </Field>
        <Field label="Job title" error={errors.job_title}><Input value={values.job_title} onChange={set('job_title')} readOnly={!canEditEmployeeFields} /></Field>
        <Field label="Default branch" error={errors.default_branch_id} hint="Must be a branch this user has a role in.">
          <Select value={values.default_branch_id} onChange={set('default_branch_id')}>
            <option value="">None</option>
            {(branches.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
      </form>
    </Modal>
  )
}
