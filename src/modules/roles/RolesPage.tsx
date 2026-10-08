import { useQuery } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge, Card, CardBody, CardHeader, ErrorState, LoadingState, PageHeader, Tabs } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { listPermissions, listRolesWithPermissions, type RoleWithPermissions } from '@/services/roles'

/**
 * Read-only inspection of the RBAC model. Role/permission definitions are system reference data changed by
 * migrations; assignments are changed from the Users page through guarded database functions.
 */
export function RolesPage() {
  const [tab, setTab] = useState('roles')
  const rolesQ = useQuery({ queryKey: ['roles', 'with-permissions'], queryFn: listRolesWithPermissions, staleTime: 5 * 60_000 })
  const permsQ = useQuery({ queryKey: ['permissions'], queryFn: listPermissions, staleTime: 5 * 60_000 })

  const permissions = permsQ.data
  const permsByModule = useMemo(() => {
    const m = new Map<string, NonNullable<typeof permissions>>()
    for (const p of permissions ?? []) m.set(p.module, [...(m.get(p.module) ?? []), p])
    return [...m.entries()]
  }, [permissions])

  if (rolesQ.isPending || permsQ.isPending) return <LoadingState />
  if (rolesQ.isError || permsQ.isError) {
    return <ErrorState message={toAppError(rolesQ.error ?? permsQ.error).message} onRetry={() => { void rolesQ.refetch(); void permsQ.refetch() }} />
  }
  const roles = rolesQ.data ?? []
  const codesOf = (r: RoleWithPermissions) => new Set(r.role_permissions.map((rp) => rp.permission?.code).filter((c): c is string => Boolean(c)))

  return (
    <>
      <PageHeader title="Roles & permissions" description="What each role can do. Roles are assigned to people from the Users page, organization-wide or for a single branch." />
      <Tabs label="Roles views" value={tab} onChange={setTab} items={[{ id: 'roles', label: 'Roles', badge: roles.length }, { id: 'matrix', label: 'Permission matrix' }]} />
      <div className="mt-4">
        {tab === 'roles' ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {roles.map((r) => {
              const codes = [...codesOf(r)].sort()
              return (
                <Card key={r.id}>
                  <CardHeader title={r.name} description={r.description ?? undefined} actions={r.is_system_role ? <Badge>System</Badge> : <Badge tone="purple">Custom</Badge>} />
                  <CardBody>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">{codes.length} permission{codes.length === 1 ? '' : 's'}</p>
                    <div className="flex flex-wrap gap-1">
                      {codes.length === 0 && <span className="text-sm text-slate-400">No permissions in this phase.</span>}
                      {codes.map((c) => <code key={c} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">{c}</code>)}
                    </div>
                  </CardBody>
                </Card>
              )
            })}
          </div>
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <caption className="sr-only">Permission matrix: roles as columns, permissions as rows</caption>
                <thead className="bg-slate-50">
                  <tr>
                    <th scope="col" className="sticky left-0 bg-slate-50 px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Permission</th>
                    {roles.map((r) => (
                      <th key={r.id} scope="col" className="px-2 py-2 text-center align-bottom text-[11px] font-semibold text-slate-500">
                        <span className="inline-block max-w-[5.5rem] break-words">{r.name}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {permsByModule.map(([module, perms]) => (
                    <FragmentRows key={module} module={module} perms={perms} roles={roles} codesOf={codesOf} />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </>
  )
}

function FragmentRows({ module, perms, roles, codesOf }: {
  module: string
  perms: { code: string; description: string }[]
  roles: RoleWithPermissions[]
  codesOf: (r: RoleWithPermissions) => Set<string>
}) {
  return (
    <>
      <tr className="bg-slate-50/60">
        <th colSpan={roles.length + 1} scope="colgroup" className="sticky left-0 px-4 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
          {module.replace(/_/g, ' ')}
        </th>
      </tr>
      {perms.map((p) => (
        <tr key={p.code} className="border-t border-slate-100">
          <th scope="row" className="sticky left-0 bg-white px-4 py-1.5 text-left font-normal text-slate-700" title={p.description}>
            <code className="text-xs">{p.code}</code>
          </th>
          {roles.map((r) => (
            <td key={r.id} className="px-2 py-1.5 text-center">
              {codesOf(r).has(p.code) ? <Check className="mx-auto h-4 w-4 text-emerald-600" aria-label="Granted" /> : <span className="text-slate-200" aria-label="Not granted">·</span>}
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}
