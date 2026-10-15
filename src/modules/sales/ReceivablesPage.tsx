import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Badge, Card, DataTable, PageHeader, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { getReceivables, type ReceivablesRow } from '@/services/sales'

const fmt = (n: number) => (n === 0 ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))

export function ReceivablesPage() {
  const query = useQuery({ queryKey: ['receivables'], queryFn: getReceivables })
  const rows = query.data
  const totals = (rows ?? []).reduce(
    (t, r) => ({ outstanding: t.outstanding + r.outstanding, overdue: t.overdue + r.overdue_1_30 + r.overdue_31_60 + r.overdue_61_90 + r.overdue_over_90, credit: t.credit + r.credit_held }),
    { outstanding: 0, overdue: 0, credit: 0 },
  )
  const mixed = new Set((rows ?? []).map((r) => r.currency_code)).size > 1

  const columns: Column<ReceivablesRow>[] = [
    {
      key: 'cust', header: 'Customer',
      render: (r) => <span className="flex flex-wrap items-center gap-2"><Link to={`/sales/customers/${r.customer_id}`} className="font-medium text-slate-900 hover:underline">{r.customer_name}</Link>{r.on_hold && <Badge tone="red">On hold</Badge>}</span>,
    },
    { key: 'out', header: 'Owes', className: 'text-right', render: (r) => <span className="font-semibold tabular-nums">{fmt(r.outstanding)}</span> },
    { key: 'nd', header: 'Not yet due', hideOnMobile: true, className: 'text-right', render: (r) => <span className="tabular-nums">{fmt(r.not_due)}</span> },
    { key: 'd30', header: '1–30 days late', hideOnMobile: true, className: 'text-right', render: (r) => <span className="tabular-nums text-amber-700">{fmt(r.overdue_1_30)}</span> },
    { key: 'd60', header: '31–60', hideOnMobile: true, className: 'text-right', render: (r) => <span className="tabular-nums text-amber-700">{fmt(r.overdue_31_60)}</span> },
    { key: 'd90', header: '61–90', hideOnMobile: true, className: 'text-right', render: (r) => <span className="tabular-nums text-red-700">{fmt(r.overdue_61_90)}</span> },
    { key: 'd90p', header: 'Over 90', hideOnMobile: true, className: 'text-right', render: (r) => <span className="font-semibold tabular-nums text-red-700">{fmt(r.overdue_over_90)}</span> },
    { key: 'cr', header: 'Customer credit', hideOnMobile: true, className: 'text-right', render: (r) => <span className="tabular-nums text-slate-500">{fmt(r.credit_held)}</span> },
    { key: 'lim', header: 'Limit', hideOnMobile: true, className: 'text-right', render: (r) => (r.credit_limit > 0 ? <span className="tabular-nums">{fmt(r.credit_limit)}</span> : <span className="text-slate-500">Cash only</span>) },
  ]

  return (
    <>
      <PageHeader title="Receivables" description="What customers owe on posted invoices, by how late it is. Open a customer to see their invoices and statement." />
      <Card>
        {rows && (
          <div className="flex flex-wrap gap-x-8 gap-y-2 border-b border-slate-100 p-4 text-sm text-slate-600">
            <span>Owed <strong className="text-base tabular-nums text-slate-900">{fmt(totals.outstanding)}</strong></span>
            <span>Overdue <strong className="text-base tabular-nums text-red-700">{fmt(totals.overdue)}</strong></span>
            <span>Unused customer credit <strong className="text-base tabular-nums text-slate-900">{fmt(totals.credit)}</strong></span>
            {mixed && <span className="text-amber-700">More than one currency is in use - the totals mix them.</span>}
          </div>
        )}
        <DataTable
          caption="Receivables ageing" columns={columns} rows={rows} rowKey={(r) => r.customer_id} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()}
          emptyTitle="Nobody owes anything" emptyDescription="Posted invoices appear here until they are paid."
        />
      </Card>
    </>
  )
}
