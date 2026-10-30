import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Card, CardBody, Field, Input, PageHeader, InlineError } from '@/components/ui'
import { useSession } from '@/modules/session/SessionProvider'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/services/common'
import { toAppError } from '@/lib/errors'
import { downloadCsv } from '@/lib/download'

export function ProcurementInsightsPage() {
  const { selectedBranch } = useSession()
  const [from, setFrom] = useState(() => `${new Date().getFullYear()}-01-01`)
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10))
  const valid = !!from && !!to && from <= to
  const query = useQuery({ queryKey: ['procurement-insights', from, to, selectedBranch], enabled: valid, queryFn: async () => unwrap(await supabase.rpc('procurement_insights', { p_from: from, p_to: to, p_branch: selectedBranch === 'ALL' ? null : selectedBranch }), 'procurement.insights') })
  return <div className="space-y-4">
    <PageHeader title="Procurement insights" description="Approved purchase-order values and outstanding orders by supplier and currency. Values are commitments, not payments or received-stock costs." />
    <div className="flex flex-wrap gap-3"><Field label="From"><Input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} /></Field><Field label="To"><Input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} /></Field></div>
    {!valid && <p>Choose a valid date range.</p>}
    <InlineError message={query.isError ? toAppError(query.error).message : null} />
    {query.isError && <Button onClick={() => void query.refetch()}>Retry</Button>}
    <Button disabled={!query.data?.length || !valid} onClick={() => downloadCsv('procurement-insights', [['Supplier', 'Currency', 'Orders', 'Ordered value', 'Open orders', 'Overdue orders'], ...(query.data ?? []).map(r => [r.supplier_name, r.currency_code, r.orders, r.ordered_value, r.open_orders, r.overdue_orders])])}>Export CSV</Button>
    {valid && query.isPending ? <p>Loading...</p> : valid && query.data?.length === 0 ? <p>No approved orders in this period.</p> : valid && query.data?.map(r => <Card key={`${r.supplier_id}-${r.currency_code}`}><CardBody><h2 className="font-semibold">{r.supplier_name}</h2><p>{r.currency_code} {Number(r.ordered_value).toFixed(2)} across {r.orders} orders</p><p>{r.open_orders} open / {r.overdue_orders} past expected delivery date</p></CardBody></Card>)}
  </div>
}
