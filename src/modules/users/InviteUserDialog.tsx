import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Button, Field, InlineError, Input, Modal, Select, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { requiredText, validate } from '@/lib/validation'
import { listBranchOptions } from '@/services/branches'
import { listAssignableRoles } from '@/services/roles'
import { inviteUser } from '@/services/users'

const schema = z.object({
  email: z.string().trim().min(1, 'Email is required').email('Enter a valid email address').max(254),
  first_name: requiredText('First name', 100),
  last_name: requiredText('Last name', 100),
  job_title: z.string().trim().max(100, 'Too long').optional(),
  role_id: z.string().uuid('Choose a role'),
  branch_id: z.string().uuid().or(z.literal('')).transform((v) => v || null),
})

interface Values { email: string; first_name: string; last_name: string; job_title: string; role_id: string; branch_id: string }
const blank: Values = { email: '', first_name: '', last_name: '', job_title: '', role_id: '', branch_id: '' }

export function InviteUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return open ? <Inner onClose={onClose} /> : null
}

function Inner({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const roles = useQuery({ queryKey: ['roles', 'assignable'], queryFn: listAssignableRoles, staleTime: 5 * 60_000 })
  const branches = useQuery({ queryKey: ['branches', 'options'], queryFn: listBranchOptions, staleTime: 60_000 })
  const [values, setValues] = useState<Values>(blank)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)

  const send = useMutation({
    mutationFn: (v: z.output<typeof schema>) => inviteUser(v),
    onSuccess: async (_d, v) => {
      toast.success(`Invitation sent to ${v.email}.`)
      await qc.invalidateQueries({ queryKey: ['users'] })
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
    send.mutate(r.data)
  }

  const formId = 'invite-user-form'
  return (
    <Modal
      open
      variant="drawer"
      title="Invite a user"
      description="They receive an e-mail to set their password. Access follows the role and branch you choose."
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form={formId} loading={send.isPending}>Send invitation</Button></>}
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        <InlineError message={serverError} />
        <Field label="Email" required error={errors.email}>
          <Input type="email" autoComplete="off" value={values.email} onChange={set('email')} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name" required error={errors.first_name}><Input value={values.first_name} onChange={set('first_name')} /></Field>
          <Field label="Last name" required error={errors.last_name}><Input value={values.last_name} onChange={set('last_name')} /></Field>
        </div>
        <Field label="Job title" error={errors.job_title}><Input value={values.job_title} onChange={set('job_title')} /></Field>
        <Field label="Role" required error={errors.role_id} hint="You can only invite people into roles no more powerful than your own.">
          <Select value={values.role_id} onChange={set('role_id')}>
            <option value="">Select a role…</option>
            {(roles.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </Field>
        <Field label="Applies to" error={errors.branch_id}>
          <Select value={values.branch_id} onChange={set('branch_id')}>
            <option value="">All branches (organization-wide)</option>
            {(branches.data ?? []).filter((b) => b.is_active).map((b) => <option key={b.id} value={b.id}>Only {b.name}</option>)}
          </Select>
        </Field>
      </form>
    </Modal>
  )
}
