import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { useSession } from '@/modules/session/SessionProvider'
import { applyCreditNote, listUnusedCredit } from '@/services/creditNotes'
import { CUSTOMER_TYPE_LABEL, getCustomer, getCustomerCredit, getCustomerStatement, listCustomerOptions, type CustomerType } from '@/services/customers'
import { listOpenInvoices, moneyFmt } from '@/services/sales'
import { CustomerForm } from './CustomerForm'
import { LicenceBadge } from './CustomersPage'
import { RecordReceiptDialog } from './RecordReceiptDialog'

export function CustomerPage() {
  const { id = '' } = useParams()
  const { ability } = useSession()
  const [editing, setEditing] = useState(false)
  const [paying, setPaying] = useState(false)
  const customer = useQuery({ queryKey: ['customer', id], queryFn: () => getCustomer(id), enabled: Boolean(id) })
  const credit = useQuery({ queryKey: ['customer-credit', id], queryFn: () => getCustomerCredit(id), enabled: Boolean(id) && ability.canAnywhere('receipts.view') })
  const statement = useQuery({ queryKey: ['customer-statement', id], queryFn: () => getCustomerStatement(id), enabled: Boolean(id) && ability.canAnywhere('receipts.view') })
  const open = useQuery({ queryKey: ['open-invoices', id], queryFn: () => listOpenInvoices(id), enabled: Boolean(id) && ability.canAnywhere('sales.view') })
  const qc = useQueryClient()
  const unused = useQuery({ queryKey: ['unused-credit', id], queryFn: () => listUnusedCredit(id), enabled: Boolean(id) && ability.canAnywhere('credit_notes.view') })
  const applyCredit = useMutation({
    mutationFn: (noteId: string) => applyCreditNote(noteId),
    onSuccess: async () => { await Promise.all(['unused-credit', 'customer-credit', 'customer-statement', 'open-invoices', 'receivables', 'credit-notes', 'sales-invoices', 'dashboard'].map((k) => qc.invalidateQueries({ queryKey: [k] }))) },
  })
  const options = useQuery({ queryKey: ['customer-options'], queryFn: listCustomerOptions, staleTime: 60_000 })

  if (customer.isPending) return <LoadingState />
  if (customer.isError) return <ErrorState message={toAppError(customer.error).message} onRetry={() => void customer.refetch()} />
  const c = customer.data
  if (!c) return <EmptyState title="Customer not found" action={<Link className="text-sm font-medium text-brand-700 hover:underline" to="/sales/customers">Back to customers</Link>} />

  const cr = credit.data
  const stats: [string, string, string?][] = cr
    ? [
        ['Owes', moneyFmt(cr.outstanding)],
        ['Overdue', moneyFmt(cr.overdue), cr.overdue > 0 ? 'text-red-700' : undefined],
        ['Unused credit', moneyFmt(cr.credit_held)],
        ['Credit limit', Number(c.credit_limit) > 0 ? moneyFmt(cr.credit_limit) : 'None (cash only)'],
        ['Available', Number(c.credit_limit) > 0 ? moneyFmt(cr.available) : '—'],
      ]
    : []

  return (
    <>
      <Link to="/sales/customers" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" aria-hidden /> Customers</Link>
      <PageHeader
        title={c.name}
        description={`${c.code} · ${CUSTOMER_TYPE_LABEL[c.customer_type as CustomerType] ?? c.customer_type}${c.city ? ` · ${c.city}` : ''}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {ability.canAnywhere('sales.create') && c.is_active && <Link to={`/sales/invoices/new?customer=${c.id}`}><Button>New invoice</Button></Link>}
            {ability.canAnywhere('receipts.create') && <Button variant="secondary" onClick={() => setPaying(true)}>Record payment</Button>}
            <Button variant="secondary" onClick={() => setEditing(true)}>{ability.can('customers.edit') ? 'Edit' : 'View details'}</Button>
          </div>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusBadge active={c.is_active} />
        {c.on_hold && <Badge tone="red">Credit hold: {c.hold_reason}</Badge>}
        {c.controlled_drugs_authorised && <Badge tone="purple">Controlled drugs authorised</Badge>}
        <span className="text-sm text-slate-600">Licence <LicenceBadge c={c} />{c.licence_number ? <span className="text-slate-500"> · {c.licence_number}</span> : null}</span>
      </div>

      {stats.length > 0 && (
        <Card>
          <CardBody>
            <dl className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
              {stats.map(([k, v, tone]) => (
                <div key={k}><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{k}</dt><dd className={`mt-0.5 text-lg font-semibold tabular-nums ${tone ?? 'text-slate-900'}`}>{v}</dd></div>
              ))}
            </dl>
          </CardBody>
        </Card>
      )}

      {(unused.data ?? []).length > 0 && (
        <div className="mt-5">
          <Card>
            <CardHeader title="Unused credit notes" description="Credit that has not been applied to an invoice yet. It counts against what the customer owes." />
            <CardBody>
              <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
                {(unused.data ?? []).map((n) => (
                  <li key={n.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span><Link to={`/sales/credit-notes/${n.id}`} className="font-mono text-xs font-semibold text-brand-700 hover:underline">{n.credit_note_number}</Link> <span className="text-slate-500">for {n.invoice?.invoice_number}</span></span>
                    <span className="flex items-center gap-3">
                      <span className="tabular-nums">{moneyFmt(n.unapplied_amount)}</span>
                      {ability.can('credit_notes.post', n.branch_id) && <Button size="sm" variant="secondary" loading={applyCredit.isPending && applyCredit.variables === n.id} onClick={() => applyCredit.mutate(n.id)}>Apply to invoices</Button>}
                    </span>
                  </li>
                ))}
              </ul>
              {applyCredit.isError && <p className="mt-2 text-sm text-red-600">{toAppError(applyCredit.error).message}</p>}
            </CardBody>
          </Card>
        </div>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Open invoices" description="Posted invoices with something still to pay, oldest due first." />
          <CardBody>
            {open.isPending ? <LoadingState /> : open.isError ? <ErrorState message={toAppError(open.error).message} onRetry={() => void open.refetch()} /> : (open.data ?? []).length === 0 ? (
              <EmptyState title="Nothing owed" />
            ) : (
              <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
                {(open.data ?? []).map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span><Link to={`/sales/invoices/${i.id}`} className="font-mono text-xs font-semibold text-brand-700 hover:underline">{i.invoice_number}</Link> <span className="text-slate-500">due {i.due_date}</span></span>
                    <span className={`tabular-nums ${i.due_date && i.due_date < new Date().toISOString().slice(0, 10) ? 'font-semibold text-red-700' : ''}`}>{moneyFmt(i.balance_due)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Details" />
          <CardBody>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {([
                ['Payment terms', `${c.payment_terms_days} days`],
                ['Minimum shelf life', c.min_shelf_life_days > 0 ? `${c.min_shelf_life_days} days` : 'Any'],
                ['Registered pharmacist', c.registered_pharmacist ?? '—'],
                ['Contact', [c.contact_name, c.phone].filter(Boolean).join(' · ') || '—'],
                ['Email', c.email ?? '—'],
                ['Address', [c.address, c.city, c.region].filter(Boolean).join(', ') || '—'],
                ['Tax number', c.tax_number ?? '—'],
                ['Customer since', formatDateTime(c.created_at)],
              ] as [string, string][]).map(([k, v]) => (
                <div key={k}><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{k}</dt><dd className="mt-0.5 text-sm text-slate-900">{v}</dd></div>
              ))}
            </dl>
            {c.notes && <p className="mt-4 text-sm text-slate-600">{c.notes}</p>}
          </CardBody>
        </Card>
      </div>

      {ability.canAnywhere('receipts.view') && (
        <div className="mt-5">
          <Card>
            <CardHeader title="Statement" description="Every posted invoice and receipt with the running balance." />
            <CardBody>
              {statement.isPending ? <LoadingState /> : statement.isError ? <ErrorState message={toAppError(statement.error).message} onRetry={() => void statement.refetch()} /> : (statement.data ?? []).length === 0 ? (
                <EmptyState title="No activity yet" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <caption className="sr-only">Customer statement</caption>
                    <thead className="text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-2 pr-4">Date</th><th className="pr-4">Document</th><th className="pr-4">Details</th><th className="pr-4 text-right">Invoiced</th><th className="pr-4 text-right">Paid</th><th className="text-right">Balance</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {(statement.data ?? []).map((r) => (
                        <tr key={`${r.entry_type}-${r.reference}`}>
                          <td className="py-2 pr-4 whitespace-nowrap">{r.entry_date}</td>
                          <td className="pr-4 font-mono text-xs">{r.reference}</td>
                          <td className="pr-4 text-slate-600">{r.description}</td>
                          <td className="pr-4 text-right tabular-nums">{r.debit > 0 ? moneyFmt(r.debit) : ''}</td>
                          <td className="pr-4 text-right tabular-nums text-green-700">{r.credit > 0 ? moneyFmt(r.credit) : ''}</td>
                          <td className="text-right font-medium tabular-nums">{moneyFmt(r.balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      )}

      <CustomerForm open={editing} customer={c} canEdit={ability.can('customers.edit')} onClose={() => setEditing(false)} />
      {paying && <RecordReceiptDialog customers={options.data ?? []} presetCustomerId={c.id} onClose={() => setPaying(false)} />}
    </>
  )
}
