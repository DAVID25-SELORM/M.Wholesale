import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Card, CardBody, CardHeader, PageHeader, Button, Input } from '@/components/ui'

const names: Record<string, { description: string; fields: string[] }> = {
  approvals: { description: 'Review and route operational approvals from one responsive queue.', fields: ['Reference', 'Owner', 'Decision'] },
  integrations: { description: 'Configure external connections and monitor their health.', fields: ['Provider', 'Environment', 'Status'] },
  'price-agreements': { description: 'Manage customer and supplier pricing agreements with effective dates.', fields: ['Agreement', 'Customer or supplier', 'Effective date'] },
  'purchase-requests': { description: 'Capture internal purchase needs before they become purchase orders.', fields: ['Requester', 'Required date', 'Priority'] },
  'supplier-quotations': { description: 'Compare supplier quotations and record the selected offer.', fields: ['Supplier', 'Quotation number', 'Valid until'] },
  'credit-control': { description: 'Track credit exposure, promises and collection follow-ups.', fields: ['Customer', 'Due date', 'Follow-up'] },
  expenses: { description: 'Record, review and reconcile operating expenses.', fields: ['Payee', 'Amount', 'Expense date'] },
  'sales-reps': { description: 'Maintain the sales team and their customer assignments.', fields: ['Name', 'Territory', 'Status'] },
  territories: { description: 'Organize customers and sales activity by territory.', fields: ['Territory', 'Manager', 'Coverage'] },
  visits: { description: 'Plan customer visits and capture follow-up actions.', fields: ['Customer', 'Visit date', 'Outcome'] },
  targets: { description: 'Set measurable sales targets and review progress.', fields: ['Team member', 'Period', 'Target'] },
  replenishment: { description: 'Identify stock that needs replenishment using current inventory signals.', fields: ['Warehouse', 'Supplier', 'Review period'] },
  'customer-insights': { description: 'Review customer activity, value and service signals.', fields: ['Customer', 'Segment', 'Period'] },
  'product-performance': { description: 'Compare product movement, margin and availability.', fields: ['Product', 'Category', 'Period'] },
  'procurement-insights': { description: 'Review supplier performance, lead times and purchasing trends.', fields: ['Supplier', 'Category', 'Period'] },
}

const titleCase = (value: string) => value.split('-').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ')

export function WorkspaceModulePage() {
  const { module = '' } = useParams()
  const config = names[module] ?? { description: 'Manage this workspace module.', fields: ['Name', 'Status', 'Notes'] }
  const title = titleCase(module)
  const [saved, setSaved] = useState(false)
  const [query, setQuery] = useState('')
  const rows = useMemo(() => saved ? [{ id: 1, label: query || 'New workspace record', status: 'Draft' }] : [], [query, saved])

  return <div className="min-w-0">
    <PageHeader title={title} description={config.description} actions={<Button onClick={() => setSaved(true)}>Add record</Button>} />
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
      <Card>
        <CardHeader title="Workspace" description="Responsive records view" />
        <CardBody>
          <div className="mb-4 flex flex-col gap-2 sm:flex-row">
            <Input aria-label={`Search ${title}`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${title.toLowerCase()}`} />
            <Button variant="secondary" onClick={() => setQuery('')}>Clear</Button>
          </div>
          {rows.length === 0 ? <p className="rounded-md border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">No records yet. Add a record to begin.</p> : <div className="space-y-2">{rows.map((row) => <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 p-3"><span className="font-medium text-slate-800">{row.label}</span><span className="rounded-full bg-amber-50 px-2 py-1 text-xs text-amber-700">{row.status}</span></div>)}</div>}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Quick entry" description="Capture the essentials" />
        <CardBody className="space-y-3">
          {config.fields.map((field) => <label key={field} className="block text-sm font-medium text-slate-700">{field}<Input className="mt-1" aria-label={field} /> </label>)}
          <Button className="w-full" onClick={() => setSaved(true)}>Save draft</Button>
        </CardBody>
      </Card>
    </div>
  </div>
}
