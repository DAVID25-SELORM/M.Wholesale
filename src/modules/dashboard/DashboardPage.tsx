import { useQuery } from '@tanstack/react-query'
import { Boxes, CircleDollarSign, ListChecks, PackageSearch } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Badge, Card, CardBody, CardHeader, PageHeader } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/modules/session/SessionProvider'
import { daysUntil, fmtQty, listExpiringStock, listStockSummary } from '@/services/inventory'
import { getReceivables, moneyFmt } from '@/services/sales'

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

/** Work waiting for this person; each row only appears if they hold the permission to act on it. */
const TODO = [
  { key: 'po', label: 'purchase orders awaiting approval', table: 'purchase_orders', column: 'status', values: ['SUBMITTED'], perm: 'purchasing.approve', to: '/purchasing/orders' },
  { key: 'inv', label: 'supplier invoices to approve', table: 'supplier_invoices', column: 'status', values: ['MATCHED', 'EXCEPTION'], perm: 'payables.approve', to: '/purchasing/invoices' },
  { key: 'cnt', label: 'stock counts to approve', table: 'stock_counts', column: 'status', values: ['SUBMITTED'], perm: 'inventory.count_approve', to: '/inventory/counts' },
  { key: 'trf', label: 'transfers on the way', table: 'stock_transfers', column: 'status', values: ['IN_TRANSIT', 'PARTIALLY_RECEIVED'], perm: 'inventory.transfer', to: '/inventory/transfers' },
  { key: 'drf', label: 'sales invoices still in draft', table: 'sales_invoices', column: 'status', values: ['DRAFT'], perm: 'sales.create', to: '/sales/invoices' },
  { key: 'ret', label: 'returns waiting for a credit note', table: 'purchase_returns', column: 'credit_status', values: ['PENDING'], perm: 'payables.create', to: '/purchasing/returns' },
] as const

function useTodoCounts(enabled: boolean) {
  return useQuery({
    queryKey: ['dashboard', 'todo'],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const out: Record<string, number> = {}
      await Promise.all(TODO.map(async (row) => {
        const { count, error } = await supabase.from(row.table).select('id', { count: 'exact', head: true }).in(row.column, [...row.values])
        if (error) throw error
        out[row.key] = count ?? 0
      }))
      return out
    },
  })
}

function useSalesGlance(enabled: boolean) {
  return useQuery({
    queryKey: ['dashboard', 'sales-glance'],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10)
      const { data, error } = await supabase.from('sales_invoices').select('total_amount').eq('status', 'POSTED').eq('invoice_date', today).limit(5000)
      if (error) throw error
      return { count: data.length, total: data.reduce((s, r) => s + Number(r.total_amount), 0) }
    },
  })
}

function useReceivablesGlance(enabled: boolean) {
  return useQuery({
    queryKey: ['dashboard', 'receivables-glance'],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const rows = await getReceivables()
      return {
        owed: rows.reduce((s, r) => s + r.outstanding, 0),
        overdue: rows.reduce((s, r) => s + r.overdue_1_30 + r.overdue_31_60 + r.overdue_61_90 + r.overdue_over_90, 0),
        debtors: rows.filter((r) => r.outstanding > 0).length,
      }
    },
  })
}

function useStockGlance(enabled: boolean) {
  return useQuery({
    queryKey: ['dashboard', 'stock-glance'],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const [summary, expiring] = await Promise.all([
        listStockSummary({ page: 0, pageSize: 1, search: '', warehouseId: '' }),
        listExpiringStock(90, ''),
      ])
      const sellable = expiring.filter((r) => r.stock_status === 'AVAILABLE')
      const days = (r: (typeof sellable)[number]) => daysUntil(r.expiry_date)
      return {
        products: summary.total ?? 0,
        expiredUnsold: sellable.filter((r) => days(r) < 0).length,
        within30: sellable.filter((r) => days(r) >= 0 && days(r) <= 30).length,
        within90: sellable.filter((r) => days(r) > 30 && days(r) <= 90).length,
      }
    },
  })
}

export function DashboardPage() {
  const { context, selectedBranchRecord, ability } = useSession()
  const counts = useSetupCounts()
  const seesStock = ability.canAnywhere('inventory.view')
  const glance = useStockGlance(seesStock)
  const seesSales = ability.canAnywhere('sales.view')
  const seesDebt = ability.canAnywhere('receipts.view')
  const sales = useSalesGlance(seesSales)
  const debt = useReceivablesGlance(seesDebt)
  const todoRows = TODO.filter((row) => ability.canAnywhere(row.perm))
  const todo = useTodoCounts(todoRows.length > 0)
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
        {todoRows.length > 0 && (
          <Card>
            <CardHeader title="Waiting for you" actions={<ListChecks className="h-5 w-5 text-slate-400" aria-hidden />} />
            <CardBody>
              {todo.isError ? <p className="text-sm text-red-600">Could not load your to-do list.</p> : (
                <ul className="divide-y divide-slate-100">
                  {todoRows.map((row) => (
                    <li key={row.key} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <span className="text-slate-700">{row.label}</span>
                      <Link to={row.to}>
                        <Badge tone={(todo.data?.[row.key] ?? 0) > 0 ? 'amber' : 'slate'}>{todo.data ? todo.data[row.key] : '…'}</Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        )}
        {seesStock && (
          <Card>
            <CardHeader title="Stock and expiry" actions={<Boxes className="h-5 w-5 text-slate-400" aria-hidden />} />
            <CardBody>
              {glance.isError ? <p className="text-sm text-red-600">Could not load stock.</p> : !glance.data ? <p className="text-sm text-slate-500">Loading…</p> : (
                <>
                  <p className="text-sm text-slate-600"><Link to="/inventory/stock" className="text-2xl font-semibold text-slate-900 hover:underline">{fmtQty(glance.data.products)}</Link> products in stock</p>
                  <ul className="mt-3 space-y-1.5 text-sm">
                    <li className="flex items-center justify-between"><span className="text-slate-700">Expired but still sellable</span><Link to="/inventory/expiry"><Badge tone={glance.data.expiredUnsold ? 'red' : 'slate'}>{glance.data.expiredUnsold}</Badge></Link></li>
                    <li className="flex items-center justify-between"><span className="text-slate-700">Batches expiring within 30 days</span><Link to="/inventory/expiry"><Badge tone={glance.data.within30 ? 'red' : 'slate'}>{glance.data.within30}</Badge></Link></li>
                    <li className="flex items-center justify-between"><span className="text-slate-700">Batches expiring in 31–90 days</span><Link to="/inventory/expiry"><Badge tone={glance.data.within90 ? 'amber' : 'slate'}>{glance.data.within90}</Badge></Link></li>
                  </ul>
                </>
              )}
            </CardBody>
          </Card>
        )}
        {seesSales && (
          <Card>
            <CardHeader title="Sales today" actions={<CircleDollarSign className="h-5 w-5 text-slate-400" aria-hidden />} />
            <CardBody>
              {sales.isError ? <p className="text-sm text-red-600">Could not load sales.</p> : !sales.data ? <p className="text-sm text-slate-500">Loading…</p> : (
                <p className="text-sm text-slate-600"><Link to="/sales/invoices" className="text-2xl font-semibold tabular-nums text-slate-900 hover:underline">{moneyFmt(sales.data.total)}</Link> from {sales.data.count} posted invoice{sales.data.count === 1 ? '' : 's'}</p>
              )}
            </CardBody>
          </Card>
        )}
        {seesDebt && (
          <Card>
            <CardHeader title="Receivables" actions={<PackageSearch className="h-5 w-5 text-slate-400" aria-hidden />} />
            <CardBody>
              {debt.isError ? <p className="text-sm text-red-600">Could not load receivables.</p> : !debt.data ? <p className="text-sm text-slate-500">Loading…</p> : (
                <>
                  <p className="text-sm text-slate-600"><Link to="/sales/receivables" className="text-2xl font-semibold tabular-nums text-slate-900 hover:underline">{moneyFmt(debt.data.owed)}</Link> owed by {debt.data.debtors} customer{debt.data.debtors === 1 ? '' : 's'}</p>
                  <p className="mt-2 text-sm text-slate-600">Overdue <Badge tone={debt.data.overdue > 0 ? 'red' : 'slate'}>{moneyFmt(debt.data.overdue)}</Badge></p>
                </>
              )}
            </CardBody>
          </Card>
        )}
      </div>
    </>
  )
}
