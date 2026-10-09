import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { UserPlus } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Card, ConfirmDialog, DataTable, PageHeader, Pagination, SearchInput, StatusBadge, useToast, type Column } from '@/components/ui'
import { useTableState } from '@/hooks/useTableState'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import { StatusFilter } from '@/modules/shared/StatusFilter'
import { listUsers, resendInvitation, setUserActive, type UserRow } from '@/services/users'
import { InviteUserDialog } from './InviteUserDialog'
import { UserForm } from './UserForm'
import { UserRolesDialog } from './UserRolesDialog'

const PAGE_SIZE = 20

export function UsersPage() {
  const { ability, context } = useSession()
  const toast = useToast()
  const qc = useQueryClient()
  const { state, setPage, setSearch, setStatus, setSort } = useTableState<'last_name' | 'created_at'>({ key: 'last_name', direction: 'asc' })
  const [editing, setEditing] = useState<UserRow | null>(null)
  const [rolesForId, setRolesForId] = useState<string | null>(null)
  const [toggle, setToggle] = useState<UserRow | null>(null)
  const [inviting, setInviting] = useState(false)

  const resend = useMutation({
    mutationFn: (u: UserRow) => resendInvitation(u.id),
    onSuccess: (_d, u) => toast.success(`Invitation re-sent to ${u.email ?? 'the user'}.`),
    onError: (e) => toast.error(toAppError(e).message),
  })

  const params = { page: state.page, pageSize: PAGE_SIZE, search: state.search, status: state.status, sortKey: state.sort.key, sortDirection: state.sort.direction }
  const query = useQuery({ queryKey: ['users', params], queryFn: () => listUsers(params), placeholderData: (prev) => prev })

  const toggleActive = useMutation({
    mutationFn: (u: UserRow) => setUserActive(u.id, !u.is_active),
    onSuccess: async (_d, u) => {
      toast.success(u.is_active ? 'User deactivated.' : 'User activated.')
      await qc.invalidateQueries({ queryKey: ['users'] })
      setToggle(null)
    },
    onError: (e) => { toast.error(toAppError(e).message); setToggle(null) },
  })

  // always the freshest copy of the row, so role changes show up inside the open dialog
  const rolesFor = query.data?.rows.find((u) => u.id === rolesForId) ?? null
  const canEdit = ability.can('users.edit')
  const canDeactivate = ability.can('users.deactivate')
  const canInvite = ability.can('users.invite')

  const columns: Column<UserRow>[] = [
    {
      key: 'name', header: 'Name', sortKey: 'last_name',
      render: (u) => (
        <div className="min-w-0">
          <p className="font-medium text-slate-900">{u.first_name} {u.last_name}{u.id === context.user_id && <Badge className="ml-2" tone="blue">You</Badge>}</p>
          <p className="truncate text-xs text-slate-500">{u.email ?? '—'}{u.job_title ? ` · ${u.job_title}` : ''}</p>
        </div>
      ),
    },
    { key: 'branch', header: 'Default branch', hideOnMobile: true, render: (u) => u.default_branch?.name ?? '—' },
    {
      key: 'roles', header: 'Roles',
      render: (u) => u.user_roles.length === 0
        ? <span className="text-slate-400">None</span>
        : <div className="flex flex-wrap gap-1">{u.user_roles.map((r) => <Badge key={r.id} tone={r.branch_id ? 'blue' : 'green'}>{r.roles?.name ?? 'Role'}</Badge>)}</div>,
    },
    { key: 'status', header: 'Status', render: (u) => <StatusBadge active={u.is_active} /> },
    {
      key: 'actions', header: '', className: 'text-right',
      render: (u) => (
        <div className="flex justify-end gap-1">
          {(canEdit || u.id === context.user_id) && <Button size="sm" variant="ghost" onClick={() => setEditing(u)}>Edit</Button>}
          <Button size="sm" variant="ghost" onClick={() => setRolesForId(u.id)}>Roles</Button>
          {canInvite && u.is_active && u.id !== context.user_id && (
            <Button size="sm" variant="ghost" title="Re-send the invitation e-mail (only works until they accept it)"
              loading={resend.isPending && resend.variables?.id === u.id} onClick={() => resend.mutate(u)}>Resend invite</Button>
          )}
          {canDeactivate && u.id !== context.user_id && (
            <Button size="sm" variant="ghost" onClick={() => setToggle(u)}>{u.is_active ? 'Deactivate' : 'Activate'}</Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        title="Users"
        description="People in your organization. Invite new people by e-mail; they choose their own password."
        actions={canInvite && <Button onClick={() => setInviting(true)}><UserPlus className="h-4 w-4" aria-hidden /> Invite user</Button>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center">
          <div className="flex-1"><SearchInput value={state.search} onChange={setSearch} placeholder="Search by name, email or employee code" label="Search users" /></div>
          <StatusFilter value={state.status} onChange={setStatus} label="User status" />
        </div>
        <DataTable
          caption="Users"
          columns={columns}
          rows={query.data?.rows}
          rowKey={(u) => u.id}
          loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null}
          onRetry={() => void query.refetch()}
          sort={state.sort}
          onSortChange={setSort}
          emptyTitle={state.search || state.status !== 'all' ? 'No users match your filters' : 'No users yet'}
        />
        <Pagination page={state.page} pageSize={PAGE_SIZE} total={query.data?.total} onPageChange={setPage} loading={query.isFetching} />
      </Card>

      <InviteUserDialog open={inviting} onClose={() => setInviting(false)} />
      <UserForm user={editing} canEditEmployeeFields={canEdit} onClose={() => setEditing(null)} />
      <UserRolesDialog user={rolesFor} onClose={() => setRolesForId(null)} />
      <ConfirmDialog
        open={toggle !== null}
        title={toggle?.is_active ? 'Deactivate user?' : 'Activate user?'}
        message={toggle?.is_active
          ? `${toggle.first_name} ${toggle.last_name} will immediately lose access. Their history is kept.`
          : `${toggle?.first_name} ${toggle?.last_name} will be able to sign in again.`}
        confirmLabel={toggle?.is_active ? 'Deactivate' : 'Activate'}
        tone={toggle?.is_active ? 'danger' : 'primary'}
        loading={toggleActive.isPending}
        onConfirm={() => toggle && toggleActive.mutate(toggle)}
        onCancel={() => setToggle(null)}
      />
    </>
  )
}
