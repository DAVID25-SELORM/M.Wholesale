import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Button, Card, CardBody, Field, Input, InlineError, PageHeader, Select } from '@/components/ui'
import { useSession } from '@/modules/session/SessionProvider'
import { supabase } from '@/lib/supabase'
import { toAppError } from '@/lib/errors'
import { listCustomers, getCustomerCredit, type Customer } from '@/services/customers'
import { moneyFmt } from '@/services/sales'

export function CreditControlPage() {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<Customer | null>(null)
  const query = useQuery({ queryKey: ['credit-customers', search, page], queryFn: () => listCustomers({ search, page, pageSize: 20, status: 'all', sortKey: 'name', sortDirection: 'asc' }) })
  return <div className="space-y-4">
    <PageHeader title="Credit control" description="Review customer exposure, credit limits, payment terms and credit holds." />
    <Field label="Search customers"><Input value={search} onChange={e => { setSearch(e.target.value); setPage(0) }} /></Field>
    <InlineError message={query.isError ? toAppError(query.error).message : null} />
    {query.isError && <Button onClick={() => void query.refetch()}>Retry</Button>}
    {query.isPending ? <p>Loading...</p> : query.data?.rows.map(c => <Card key={c.id}><CardBody className="flex flex-wrap items-center justify-between gap-3"><div><h2>{c.code} / {c.name}</h2><p>Limit: {moneyFmt(c.credit_limit)} / {c.payment_terms_days} days / {c.on_hold ? 'On hold' : 'No hold'}</p></div><Button onClick={() => setSelected(c)}>Review {c.code}</Button></CardBody></Card>)}
    {!query.isPending && query.data?.rows.length === 0 && <p>No customers match.</p>}
    <div className="flex gap-3"><Button disabled={!page || query.isFetching} onClick={() => setPage(page - 1)}>Previous</Button><span>Page {page + 1}</span><Button disabled={!query.data?.hasNext || query.isFetching} onClick={() => setPage(page + 1)}>Next</Button></div>
    {selected && <CreditEditor key={selected.id} customer={selected} onClose={() => setSelected(null)} />}
  </div>
}
function CreditEditor({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const { ability } = useSession()
  const qc = useQueryClient()
  const [limit, setLimit] = useState(String(customer.credit_limit))
  const [terms, setTerms] = useState(String(customer.payment_terms_days))
  const [hold, setHold] = useState(customer.on_hold)
  const [reason, setReason] = useState(customer.hold_reason ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const credit = useQuery({ queryKey: ['customer-credit', customer.id], queryFn: () => getCustomerCredit(customer.id), enabled: ability.canAnywhere('receipts.view') })
  async function save() {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const result = await supabase.from('customers').update({ credit_limit: Number(limit), payment_terms_days: Number(terms), on_hold: hold, hold_reason: hold ? reason.trim() : null }).eq('id', customer.id).select('id').single()
      if (result.error) throw result.error
      await Promise.all(['credit-customers', 'customers', 'customer', 'customer-credit', 'overdue-customers'].map(k => qc.invalidateQueries({ queryKey: [k] })))
      onClose()
    } catch (e) { setError(toAppError(e).message) } finally { setBusy(false) }
  }
  return <Card><CardBody><form className="space-y-3" onSubmit={e => { e.preventDefault(); void save() }}>
    <h2 className="font-semibold">{customer.name}</h2>
    <Link className="underline" to={`/sales/customers/${customer.id}`}>Open customer account</Link>
    <InlineError message={error ?? (credit.isError ? toAppError(credit.error).message : null)} />
    {credit.data && <p>Outstanding: {moneyFmt(credit.data.outstanding)} / Overdue: {moneyFmt(credit.data.overdue)} / Available credit: {moneyFmt(credit.data.available)}</p>}
    <div className="grid gap-3 sm:grid-cols-2"><Field label="Credit limit"><Input required type="number" min="0" step="0.01" value={limit} onChange={e => setLimit(e.target.value)} /></Field><Field label="Payment terms (days)"><Input required type="number" min="0" max="365" step="1" value={terms} onChange={e => setTerms(e.target.value)} /></Field></div>
    <Field label="Credit hold"><Select value={hold ? 'yes' : 'no'} onChange={e => setHold(e.target.value === 'yes')}><option value="no">No hold</option><option value="yes">Block credit sales</option></Select></Field>
    {hold && <Field label="Hold reason"><Input required minLength={3} maxLength={300} value={reason} onChange={e => setReason(e.target.value)} /></Field>}
    <div className="flex flex-wrap gap-3">{ability.can('customers.edit') && <Button type="submit" disabled={busy}>Save credit controls</Button>}<Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Close</Button></div>
  </form></CardBody></Card>
}
