import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Badge, Button, Field, InlineError, Input, Modal, Select, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { SESSION_QUERY_KEY, useSession } from '@/modules/session/SessionProvider'
import { listBranchOptions } from '@/services/branches'
import { listAssignableRoles } from '@/services/roles'
import { assignUserRole, revokeUserRole, type UserRow } from '@/services/users'

/**
 * Assign / revoke roles. The database function enforces: caller must hold roles.assign, may only hand out
 * roles no more powerful than their own, and the last administrator cannot be removed. Errors surface as-is.
 */
export function UserRolesDialog({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  return user ? <Inner user={user} onClose={onClose} /> : null
}

function Inner({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const { ability, context } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const roles = useQuery({ queryKey: ['roles', 'assignable'], queryFn: listAssignableRoles, staleTime: 5 * 60_000 })
  const branches = useQuery({ queryKey: ['branches', 'options'], queryFn: listBranchOptions, staleTime: 60_000 })
  const [roleId, setRoleId] = useState('')
  const [scope, setScope] = useState('') // '' = organization-wide
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const canAssign = ability.can('roles.assign')

  const refreshAll = async () => {
    await qc.invalidateQueries({ queryKey: ['users'] })
    if (user.id === context.user_id) await qc.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
  }

  const assign = useMutation({
    mutationFn: () => assignUserRole(user.id, roleId, scope || null, reason.trim() || undefined),
    onSuccess: async () => { toast.success('Role assigned.'); setRoleId(''); setReason(''); setError(null); await refreshAll() },
    onError: (e) => setError(toAppError(e).message),
  })
  const revoke = useMutation({
    mutationFn: (userRoleId: string) => revokeUserRole(userRoleId, reason.trim() || undefined),
    onSuccess: async () => { toast.success('Role removed.'); setError(null); await refreshAll() },
    onError: (e) => setError(toAppError(e).message),
  })

  const fresh = user
  const branchName = (id: string | null) => (id ? (branches.data?.find((b) => b.id === id)?.name ?? 'Branch') : 'All branches')

  return (
    <Modal open title={`Roles — ${user.first_name} ${user.last_name}`} description={user.email ?? undefined} onClose={onClose} size="lg"
      footer={<Button variant="secondary" onClick={onClose}>Done</Button>}>
      <div className="space-y-5">
        <InlineError message={error} />
        <section aria-label="Current roles">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">Current roles</h3>
          {fresh.user_roles.length === 0 && <p className="text-sm text-slate-500">No roles assigned. This user can sign in but cannot see anything.</p>}
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
            {fresh.user_roles.map((ur) => (
              <li key={ur.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0"><span className="font-medium text-slate-800">{ur.roles?.name ?? 'Role'}</span>{' '}
                  <Badge tone={ur.branch_id ? 'blue' : 'green'}>{branchName(ur.branch_id)}</Badge></span>
                {canAssign && <Button size="sm" variant="ghost" className="text-red-600" loading={revoke.isPending && revoke.variables === ur.id} onClick={() => revoke.mutate(ur.id)}>Remove</Button>}
              </li>
            ))}
          </ul>
        </section>

        {canAssign ? (
          <section aria-label="Assign a role" className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-700">Assign a role</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Role">
                <Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                  <option value="">Select a role…</option>
                  {(roles.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </Select>
              </Field>
              <Field label="Applies to">
                <Select value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value="">All branches (organization-wide)</option>
                  {(branches.data ?? []).filter((b) => b.is_active).map((b) => <option key={b.id} value={b.id}>Only {b.name}</option>)}
                </Select>
              </Field>
            </div>
            <Field label="Reason (optional, recorded in the audit log)"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} /></Field>
            <Button onClick={() => assign.mutate()} disabled={!roleId} loading={assign.isPending}>Assign role</Button>
          </section>
        ) : (
          <p className="text-sm text-slate-500">You can view this user’s roles but your role does not allow changing them.</p>
        )}
      </div>
    </Modal>
  )
}
