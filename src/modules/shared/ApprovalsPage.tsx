import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Button, Card, CardBody, InlineError, PageHeader } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'

const queues = [
  { table: 'expenses', status: 'SUBMITTED', permission: 'expenses.approve', label: 'Expenses', to: '/workspace/expenses' },
  { table: 'purchase_requests', status: 'SUBMITTED', permission: 'purchasing.request_approve', label: 'Purchase requests', to: '/workspace/purchase-requests' },
  { table: 'purchase_orders', status: 'SUBMITTED', permission: 'purchasing.approve', label: 'Purchase orders', to: '/purchasing/orders' },
  { table: 'controlled_adjustments', status: 'PENDING', permission: 'inventory.controlled_approve', label: 'Controlled adjustments', to: '/inventory/controlled-adjustments' },
] as const

export function ApprovalsPage() {
  const { ability, selectedBranch } = useSession()
  return <div className="space-y-4">
    <PageHeader title="Approvals" description="Review pending requests in their workflow before making a decision. Independent approval rules apply." />
    <div className="grid gap-4 md:grid-cols-3">{queues.filter(q => ability.canAnywhere(q.permission)).map(q => <ApprovalQueue key={q.table} queue={q} branch={selectedBranch} />)}</div>
    {!queues.some(q => ability.canAnywhere(q.permission)) && <p>Your role has no approval permissions.</p>}
  </div>
}
function ApprovalQueue({ queue, branch }: { queue: typeof queues[number]; branch: string }) {
  const query = useQuery({ queryKey: ['approval-count', queue.table, branch], queryFn: async () => {
    let request = supabase.from(queue.table).select('id', { count: 'exact', head: true }).eq('status', queue.status)
    if (branch !== 'ALL') request = request.eq('branch_id', branch)
    const result = await request
    if (result.error) throw result.error
    return result.count ?? 0
  }, refetchInterval: 60000 })
  return <Card><CardBody className="space-y-3">
    <h2 className="font-semibold">{queue.label}</h2>
    {query.isPending ? <p>Loading...</p> : query.isError ? <><InlineError message={toAppError(query.error).message} /><Button onClick={() => void query.refetch()}>Retry</Button></> : <p>{query.data} awaiting review in your accessible scope</p>}
    <Link className="text-brand-700 underline" to={queue.to}>Review {queue.label.toLowerCase()}</Link>
  </CardBody></Card>
}
