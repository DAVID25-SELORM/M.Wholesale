import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Badge, Button, Card, DataTable, PageHeader, Pagination, SearchInput, StatusBadge, type Column } from '@/components/ui'
import { useTableState } from '@/hooks/useTableState'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import { StatusFilter } from '@/modules/shared/StatusFilter'
import { CUSTOMER_TYPE_LABEL, licenceDaysLeft, listCustomers, type Customer, type CustomerType } from '@/services/customers'
import { moneyFmt } from '@/services/sales'
import { CustomerForm } from './CustomerForm'

const PAGE_SIZE = 20

export function LicenceBadge({ c }: { c: Pick<Customer, 'licence_expiry' | 'licence_number'> }) {
  const d = licenceDaysLeft(c.licence_expiry)
  if (d === null) return <Badge tone="amber">Not recorded</Badge>
  if (d < 0) return <Badge tone="red">Expired {c.licence_expiry}</Badge>
  if (d <= 60) return <Badge tone="amber">Expires in {d} d</Badge>
  return <span className="text-sm text-slate-600">{c.licence_expiry}</span>
}

export function CustomersPage() {
  const { ability } = useSession()
  const navigate = useNavigate()
  const { state, setPage, setSearch, setStatus, setSort } = useTableState<'name' | 'code' | 'licence_expiry'>({ key: 'name', direction: 'asc' })
  const [creating, setCreating] = useState(false)
  const params = { page: state.page, pageSize: PAGE_SIZE, search: state.search, status: state.status, sortKey: state.sort.key, sortDirection: state.sort.direction }
  const query = useQuery({ queryKey: ['customers', params], queryFn: () => listCustomers(params), placeholderData: (p) => p })

  const columns: Column<Customer>[] = [
    { key: 'code', header: 'Code', sortKey: 'code', render: (c) => <span className="font-mono text-xs font-semibold">{c.code}</span> },
    {
      key: 'name', header: 'Customer', sortKey: 'name',
      render: (c) => (
        <Link to={`/sales/customers/${c.id}`} className="block min-w-0 hover:underline">
          <span className="font-medium text-slate-900">{c.name}</span>
          <span className="block text-xs text-slate-500">{CUSTOMER_TYPE_LABEL[c.customer_type as CustomerType] ?? c.customer_type}{c.city ? ` · ${c.city}` : ''}{c.contact_name ? ` · ${c.contact_name}` : ''}</span>
        </Link>
      ),
    },
    { key: 'licence', header: 'Licence', sortKey: 'licence_expiry', hideOnMobile: true, render: (c) => <LicenceBadge c={c} /> },
    { key: 'credit', header: 'Credit', hideOnMobile: true, className: 'text-right', render: (c) => (Number(c.credit_limit) > 0 ? <span className="tabular-nums">{moneyFmt(c.credit_limit)} <span className="text-xs text-slate-500">· {c.payment_terms_days} d</span></span> : <span className="text-slate-500">Cash only</span>) },
    { key: 'status', header: 'Status', render: (c) => <span className="flex flex-wrap items-center gap-1"><StatusBadge active={c.is_active} />{c.on_hold && <Badge tone="red">On hold</Badge>}</span> },
  ]

  return (
    <>
      <PageHeader
        title="Customers"
        description="Pharmacies, hospitals, clinics and other buyers, with their licence, credit terms and price list."
        actions={ability.can('customers.create') && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> New customer</Button>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center">
          <div className="flex-1"><SearchInput value={state.search} onChange={setSearch} placeholder="Search by name, code, licence, contact or phone" label="Search customers" /></div>
          <StatusFilter value={state.status} onChange={setStatus} label="Customer status" />
        </div>
        <DataTable
          caption="Customers" columns={columns} rows={query.data?.rows} rowKey={(c) => c.id} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()}
          sort={state.sort} onSortChange={setSort}
          emptyTitle={state.search ? 'No customers match' : 'No customers yet'} emptyDescription={state.search ? 'Try fewer words or a code.' : 'Create your first customer to start selling.'}
        />
        <Pagination page={state.page} pageSize={PAGE_SIZE} total={query.data?.total} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>
      <CustomerForm open={creating} customer={null} canEdit={ability.can('customers.create')} onClose={() => setCreating(false)} onSaved={(id) => navigate(`/sales/customers/${id}`)} />
    </>
  )
}
