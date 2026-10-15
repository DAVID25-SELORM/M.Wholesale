import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Mail, MessageCircle, Printer, Smartphone } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, DataTable, Field, InlineError, Modal, PageHeader, Select, Textarea, useToast, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { useSession } from '@/modules/session/SessionProvider'
import { getOrganization } from '@/services/organization'
import {
  REMINDER_CHANNELS, REMINDER_CHANNEL_LABEL, REMINDER_LEVEL_LABEL, listOverdueCustomers, listOverdueInvoices, listReminders, recordReminder,
  type OverdueCustomer, type ReminderChannel,
} from '@/services/reports'
import { moneyFmt } from '@/services/sales'
import { buildReminderMessage, whatsappNumber } from './reminderText'

const daysLate = (due: string | null) => (due ? Math.max(1, Math.round((Date.now() - new Date(`${due}T00:00:00`).getTime()) / 86_400_000)) : 1)

export function RemindersPage() {
  const [target, setTarget] = useState<OverdueCustomer | null>(null)
  const query = useQuery({ queryKey: ['overdue-customers'], queryFn: () => listOverdueCustomers(1) })
  const rows = query.data ?? []
  const total = rows.reduce((s, r) => s + r.overdue_amount, 0)

  const columns: Column<OverdueCustomer>[] = [
    { key: 'c', header: 'Customer', render: (r) => <span className="flex flex-wrap items-center gap-2"><Link to={`/sales/customers/${r.customer_id}`} className="font-medium text-slate-900 hover:underline">{r.customer_name}</Link>{r.on_hold && <Badge tone="red">On hold</Badge>}</span> },
    { key: 'amt', header: 'Overdue', className: 'text-right', render: (r) => <span className="font-semibold tabular-nums text-red-700">{moneyFmt(r.overdue_amount)}</span> },
    { key: 'inv', header: 'Invoices', hideOnMobile: true, className: 'text-right', render: (r) => r.invoices },
    { key: 'days', header: 'Oldest', className: 'text-right', render: (r) => <span className={r.oldest_days > 60 ? 'font-semibold text-red-700' : r.oldest_days > 30 ? 'text-amber-700' : ''}>{r.oldest_days} d</span> },
    {
      key: 'last', header: 'Last reminder', hideOnMobile: true,
      render: (r) => (r.last_reminder_at ? <span className="text-slate-600">{REMINDER_LEVEL_LABEL[r.last_level ?? 1]} · {formatDateTime(r.last_reminder_at)}</span> : <span className="text-slate-400">None yet</span>),
    },
    { key: 'act', header: '', className: 'text-right', render: (r) => <Button size="sm" variant={r.suggested_level ? 'primary' : 'secondary'} onClick={() => setTarget(r)}>{r.suggested_level ? `Remind (${REMINDER_LEVEL_LABEL[r.suggested_level]?.toLowerCase()})` : 'Remind again'}</Button> },
  ]

  return (
    <>
      <PageHeader title="Payment reminders" description="Customers with invoices past their due date. Write the reminder here, send it by e-mail, SMS, WhatsApp or letter, then record it so the next person knows." />
      <Card>
        {rows.length > 0 && <div className="border-b border-slate-100 p-4 text-sm text-slate-600">{rows.length} customer{rows.length === 1 ? '' : 's'} owe <strong className="text-base tabular-nums text-red-700">{moneyFmt(total)}</strong> past due.</div>}
        <DataTable
          caption="Overdue customers" columns={columns} rows={rows} rowKey={(r) => r.customer_id} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()}
          emptyTitle="Nobody is overdue" emptyDescription="Customers appear here once an invoice passes its due date without being paid."
        />
      </Card>
      {target && <ReminderDialog customer={target} onClose={() => setTarget(null)} />}
    </>
  )
}

function ReminderDialog({ customer, onClose }: { customer: OverdueCustomer; onClose: () => void }) {
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const orgQuery = useQuery({ queryKey: ['organization'], queryFn: getOrganization, staleTime: 5 * 60_000 })
  const invoices = useQuery({ queryKey: ['overdue-invoices', customer.customer_id], queryFn: () => listOverdueInvoices(customer.customer_id) })
  const history = useQuery({ queryKey: ['reminders', customer.customer_id], queryFn: () => listReminders(customer.customer_id), enabled: ability.canAnywhere('reminders.view') })
  const org = orgQuery.data
  const [level, setLevel] = useState(customer.suggested_level ?? Math.min(3, (customer.last_level ?? 0) + 1))
  const [channel, setChannel] = useState<ReminderChannel>(customer.phone ? 'SMS' : customer.email ? 'EMAIL' : 'PHONE')
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [edited, setEdited] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const list = (invoices.data ?? []).filter((i) => picked[i.id] !== false)
  const generated = buildReminderMessage({
    level, customerName: customer.customer_name, contactName: customer.contact_name, organization: org?.trading_name || org?.legal_name || org?.name || '',
    organizationPhone: org?.phone ?? null, invoices: list.map((i) => ({ number: i.invoice_number ?? '', due: i.due_date ?? '', amount: i.balance_due, daysLate: daysLate(i.due_date) })),
  })
  const message = edited ?? generated
  const wa = whatsappNumber(customer.phone)

  const record = useMutation({
    mutationFn: () => recordReminder({ customerId: customer.customer_id, level, channel, message, invoiceIds: list.map((i) => i.id) }),
    onSuccess: async () => {
      toast.success('Reminder recorded.')
      await Promise.all(['overdue-customers', 'reminders'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
      onClose()
    },
    onError: (e) => setError(toAppError(e).message),
  })
  async function copy() {
    try { await navigator.clipboard.writeText(message); toast.success('Copied.') } catch { setError('Could not copy: select the text and copy it by hand.') }
  }
  const subject = encodeURIComponent(`Overdue invoices - ${org?.trading_name || org?.name || ''}`)

  return (
    <Modal
      open size="lg" onClose={onClose} title={`Remind ${customer.customer_name}`}
      description={`${moneyFmt(customer.overdue_amount)} overdue on ${customer.invoices} invoice${customer.invoices === 1 ? '' : 's'}, oldest ${customer.oldest_days} days.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={record.isPending}>Close</Button>
          {ability.canAnywhere('reminders.send') && <Button onClick={() => { setError(null); if (list.length === 0) setError('Choose at least one invoice.'); else record.mutate() }} loading={record.isPending}>Record as sent</Button>}
        </>
      }
    >
      <div className="space-y-4">
        <InlineError message={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tone">
            <Select value={level} onChange={(e) => { setLevel(Number(e.target.value)); setEdited(null) }}>
              {[1, 2, 3].map((l) => <option key={l} value={l}>{REMINDER_LEVEL_LABEL[l]}</option>)}
            </Select>
          </Field>
          <Field label="Sent by">
            <Select value={channel} onChange={(e) => setChannel(e.target.value as ReminderChannel)}>{REMINDER_CHANNELS.map((c) => <option key={c} value={c}>{REMINDER_CHANNEL_LABEL[c]}</option>)}</Select>
          </Field>
        </div>
        <fieldset className="rounded-md border border-slate-200 p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Invoices it covers</legend>
          <ul className="space-y-1 text-sm">
            {(invoices.data ?? []).map((i) => (
              <li key={i.id}><label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4" checked={picked[i.id] !== false} onChange={(e) => { setPicked((p) => ({ ...p, [i.id]: e.target.checked })); setEdited(null) }} />
                <span className="font-mono text-xs">{i.invoice_number}</span><span className="text-slate-500">due {i.due_date} · {daysLate(i.due_date)} days late</span><span className="ml-auto tabular-nums">{moneyFmt(i.balance_due)}</span></label></li>
            ))}
          </ul>
        </fieldset>
        <Field label="Message" hint="Edit freely. This exact text is what gets recorded."><Textarea rows={11} value={message} onChange={(e) => setEdited(e.target.value)} /></Field>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => void copy()}><Copy className="h-4 w-4" aria-hidden /> Copy</Button>
          {customer.email && <a className="inline-flex" href={`mailto:${customer.email}?subject=${subject}&body=${encodeURIComponent(message)}`}><Button type="button" size="sm" variant="secondary"><Mail className="h-4 w-4" aria-hidden /> E-mail</Button></a>}
          {customer.phone && <a className="inline-flex" href={`sms:${customer.phone.replace(/[^\d+]/g, '')}?body=${encodeURIComponent(message)}`}><Button type="button" size="sm" variant="secondary"><Smartphone className="h-4 w-4" aria-hidden /> SMS</Button></a>}
          {wa && <a className="inline-flex" href={`https://wa.me/${wa}?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer noopener"><Button type="button" size="sm" variant="secondary"><MessageCircle className="h-4 w-4" aria-hidden /> WhatsApp</Button></a>}
          <Button type="button" size="sm" variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" aria-hidden /> Print letter</Button>
        </div>
        <p className="text-xs text-slate-500">These open your own mail, SMS or WhatsApp app with the text filled in; nothing is sent from here. Press “Record as sent” afterwards.</p>
        {(history.data ?? []).length > 0 && (
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Earlier reminders</p>
            <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
              {(history.data ?? []).map((h) => <li key={h.id} className="flex items-center justify-between gap-3 px-3 py-2"><span>{REMINDER_LEVEL_LABEL[h.level]} · {REMINDER_CHANNEL_LABEL[h.channel]}</span><span className="text-slate-500">{formatDateTime(h.sent_at)} · {moneyFmt(h.overdue_amount)}</span></li>)}
            </ul>
          </div>
        )}
      </div>
      <div id="print-area" className="hidden whitespace-pre-line p-8 text-sm leading-relaxed text-slate-900 print:block">
        <p className="mb-6 text-lg font-semibold">{org?.legal_name || org?.name}</p>
        <p className="mb-6 text-slate-600">{[org?.address, org?.city].filter(Boolean).join(', ')}</p>
        <p className="mb-6">{new Date().toLocaleDateString()}</p>
        {message}
      </div>
    </Modal>
  )
}
