import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Badge, Card, DataTable, PageHeader, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { getPayablesSummary, type PayablesRow } from '@/services/payables'

const fmt = (n: number) => (n === 0 ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))

export function PayablesPage() {
  const query = useQuery({ queryKey: ['payables'], queryFn: getPayablesSummary })
  const rows = query.data
  const totals = (rows ?? []).reduce(
    (t, r) => ({
      outstanding: t.outstanding + r.outstanding,
      overdue: t.overdue + r.overdue_1_30 + r.overdue_31_60 + r.overdue_61_90 + r.overdue_over_90,
      pending: t.pending + r.awaiting_approval,
    }),
    { outstanding: 0, overdue: 0, pending: 0 },
  )
  const mixed = new Set((rows ?? []).map((r) => r.currency_code)).size > 1

  const columns: Column<PayablesRow>[] = [
    { key: 'supplier', header: 'Supplier', render: (r) => <Link to={`/purchasing/invoices?supplier=${r.supplier_id}`} className="font-medium text-slate-900 hover:underline">{r.supplier_name}</Link> },
    { key: 'cur', header: 'Currency', hideOnMobile: true, render: (r) => <span className="text-xs text-slate-500">{r.currency_code}</span> },
    { key: 'out', header: 'Owed (approved)', className: 'text-right', render: (r) => <span className="font-semibold tabular-nums">{fmt(r.outstanding)}</span> },
    { key: 'nd', header: 'Not yet due', hideOnMobile: true, className: 'text-right', render: (r) => <span className="tabular-nums">{fmt(r.not_due)}</span> },
    { key: 'd30', header: '1–30 days late', hideOnMobile: true, className: 'text-right', render: (r) => <span className="tabular-nums text-amber-700">{fmt(r.overdue_1_30)}</span> },
    { key: 'd60', header: '31–60', hideOnMobile: true, className: 'text-right', render: (r) => <span className="tabular-nums text-amber-700">{fmt(r.overdue_31_60)}</span> },
    { key: 'd90', header: '61–90', hideOnMobile: true, className: 'text-right', render: (r) => <span className="tabular-nums text-red-700">{fmt(r.overdue_61_90)}</span> },
    { key: 'd90p', header: 'Over 90', hideOnMobile: true, className: 'text-right', render: (r) => <span className="font-semibold tabular-nums text-red-700">{fmt(r.overdue_over_90)}</span> },
    { key: 'pend', header: 'Awaiting approval', className: 'text-right', render: (r) => (r.awaiting_approval > 0 ? <Badge tone="amber">{fmt(r.awaiting_approval)}</Badge> : '—') },
    { key: 'cr', header: 'Credit expected', hideOnMobile: true, className: 'text-right', render: (r) => <span className="tabular-nums text-slate-500">{fmt(r.credit_expected)}</span> },
  ]

  return (
    <>
      <PageHeader title="Payables" description="What you owe suppliers on approved invoices, by how late it is. Credit expected comes from returned goods whose credit note has not arrived." />
      <Card>
        {rows && (
          <div className="flex flex-wrap gap-x-8 gap-y-2 border-b border-slate-100 p-4 text-sm text-slate-600">
            <span>Owed <strong className="text-base tabular-nums text-slate-900">{fmt(totals.outstanding)}</strong></span>
            <span>Overdue <strong className="text-base tabular-nums text-red-700">{fmt(totals.overdue)}</strong></span>
            <span>Awaiting approval <strong className="text-base tabular-nums text-slate-900">{fmt(totals.pending)}</strong></span>
            {mixed && <span className="text-amber-700">Suppliers are invoiced in more than one currency - the totals mix them.</span>}
          </div>
        )}
        <DataTable
          caption="Payables ageing" columns={columns} rows={rows} rowKey={(r) => `${r.supplier_id}|${r.currency_code}`} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()}
          emptyTitle="Nothing is owed" emptyDescription="Approved supplier invoices appear here until they are paid."
        />
      </Card>
    </>
  )
}
