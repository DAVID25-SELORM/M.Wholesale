import { useQuery } from '@tanstack/react-query'
import { Boxes, CircleDollarSign, Clock, PackageSearch } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/modules/session/SessionProvider'

async function headCount(table: 'branches' | 'warehouses' | 'warehouse_locations'): Promise<number> {
  const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true })
  if (error) throw error
  return count ?? 0
}

function useSetupCounts() {
  return useQuery({
    queryKey: ['dashboard', 'setup-counts'],
    staleTime: 60_000,
    queryFn: async () => {
      const [branches, warehouses, locations] = await Promise.all([
        headCount('branches'), headCount('warehouses'), headCount('warehouse_locations'),
      ])
      return { branches, warehouses, locations }
    },
  })
}

const futureWidgets = [
  { title: 'Sales', icon: CircleDollarSign, message: 'No sales data available yet.', hint: 'Sales will be enabled in a later phase.' },
  { title: 'Inventory', icon: Boxes, message: 'No inventory data available yet.', hint: 'The inventory module will be enabled in a later phase.' },
  { title: 'Expiry watch', icon: Clock, message: 'No batches are tracked yet.', hint: 'Batch and expiry tracking arrives with inventory.' },
  { title: 'Receivables', icon: PackageSearch, message: 'No receivables yet.', hint: 'Credit and payments will be enabled in a later phase.' },
]

export function DashboardPage() {
  const { context, selectedBranchRecord, ability } = useSession()
  const counts = useSetupCounts()
  const first = context.profile?.first_name ?? ''

  const setup = [
    { label: 'Branches', value: counts.data?.branches, to: '/admin/branches', perm: 'branches.view' },
    { label: 'Warehouses', value: counts.data?.warehouses, to: '/admin/warehouses', perm: 'warehouses.view' },
    { label: 'Warehouse locations', value: counts.data?.locations, to: '/admin/locations', perm: 'warehouse_locations.view' },
  ]

  return (
    <>
      <PageHeader
        title={`Welcome${first ? `, ${first}` : ''}`}
        description={`${context.organization?.name ?? ''} · ${selectedBranchRecord ? selectedBranchRecord.name : 'All branches'}`}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Organization setup" description="Your foundation: real counts across every branch you can access." />
          <CardBody>
            {counts.isError ? (
              <p className="text-sm text-red-600">Could not load setup status.</p>
            ) : (
              <dl className="grid gap-3 sm:grid-cols-3">
                {setup.map((s) => (
                  <div key={s.label} className="rounded-md border border-slate-200 p-3">
                    <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{s.label}</dt>
                    <dd className="mt-1 text-2xl font-semibold text-slate-900">{s.value ?? '…'}</dd>
                    {ability.canAnywhere(s.perm) && (
                      <Link to={s.to} className="mt-1 inline-block text-xs font-medium text-brand-700 hover:underline">Manage</Link>
                    )}
                  </div>
                ))}
              </dl>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Your access" />
          <CardBody className="space-y-2">
            {(context.roles ?? []).length === 0 && <p className="text-sm text-slate-500">No roles assigned.</p>}
            {(context.roles ?? []).map((r) => {
              const branch = context.branches?.find((b) => b.id === r.branch_id)
              return (
                <div key={r.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-medium text-slate-800">{r.role_name}</span>
                  <Badge tone={r.branch_id ? 'blue' : 'green'}>{r.branch_id ? (branch?.name ?? 'One branch') : 'All branches'}</Badge>
                </div>
              )
            })}
          </CardBody>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {futureWidgets.map((w) => (
          <Card key={w.title}>
            <CardHeader title={w.title} actions={<Badge>Coming later</Badge>} />
            <EmptyState icon={<w.icon className="h-9 w-9" />} title={w.message} description={w.hint} />
          </Card>
        ))}
      </div>
    </>
  )
}
