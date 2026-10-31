import { Button } from '@/components/ui'
import { exportRecords, textValue, type RecordData } from './api'

export function RevenueSummary({ data }: { data: RecordData }) {
  const recurring = (data.recurring ?? []) as RecordData[]
  const collected = (data.collected ?? []) as RecordData[]
  return <div className="space-y-5">
    <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Payment collection is {textValue(data.collection_status).toLowerCase()}. Recurring value represents active subscription commitments, not received payments. Currencies are reported separately.</p>
    {[{ title: 'Monthly recurring value', rows: recurring, key: 'monthly_recurring_value', description: 'Current active subscriptions; annual commitments divided by 12.' }, { title: 'Verified collections', rows: collected, key: 'amount', description: 'All recorded provider-verified payments.' }].map(group => <section key={group.key} className="space-y-4 rounded-xl border bg-white p-5">
      <h2 className="font-semibold">{group.title}</h2><p className="text-sm text-slate-500">{group.description}</p>
      {!group.rows.length && <p>No records available.</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{group.rows.map(row => <div key={textValue(row.currency)} className="min-w-0 rounded-lg border p-4"><p className="text-sm text-slate-500">{textValue(row.currency)}</p><p className="break-words text-2xl font-semibold">{Number(row[group.key]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p></div>)}</div>
      {!!group.rows.length && <Button variant="secondary" onClick={() => exportRecords(group.rows, group.key)}>Export {group.title.toLowerCase()}</Button>}
    </section>)}
  </div>
}
