import { moneyFmt } from '@/services/sales'

export interface ReminderInvoice { number: string; due: string; amount: number; daysLate: number }

export interface ReminderInput {
  level: number
  customerName: string
  contactName: string | null
  organization: string
  organizationPhone: string | null
  invoices: ReminderInvoice[]
  currency?: string
}

/** The words of a payment reminder: friendly, firm or final, listing exactly the invoices chosen. */
export function buildReminderMessage(i: ReminderInput): string {
  const cur = i.currency ?? 'GHS'
  const total = i.invoices.reduce((s, x) => s + x.amount, 0)
  const list = i.invoices.map((x) => `  ${x.number}  due ${x.due} (${x.daysLate} day${x.daysLate === 1 ? '' : 's'} late)  ${cur} ${moneyFmt(x.amount)}`).join('\n')
  const hello = `Dear ${i.contactName || i.customerName},`
  const tail = i.organizationPhone ? `\n\nIf you have a question about any of these, please call us on ${i.organizationPhone}.` : ''
  const sign = `\n\nRegards,\n${i.organization}`
  const body =
    i.level === 1
      ? `${hello}\n\nThis is a friendly reminder that the following invoices from ${i.organization} are now past their due date:\n\n${list}\n\nTotal overdue: ${cur} ${moneyFmt(total)}.\nIf you have already paid, please disregard this message and accept our thanks; otherwise we would be grateful if you could arrange payment soon.`
      : i.level === 2
        ? `${hello}\n\nOur records show that the following invoices remain unpaid despite our earlier reminder:\n\n${list}\n\nTotal overdue: ${cur} ${moneyFmt(total)}.\nPlease settle this amount within the next 7 days, or contact us today to agree a payment date.`
        : `${hello}\n\nFINAL NOTICE. The following invoices are seriously overdue:\n\n${list}\n\nTotal overdue: ${cur} ${moneyFmt(total)}.\nUnless payment is received within 7 days, we will have to place your account on hold and stop further supplies until it is cleared.`
  return body + tail + sign
}

/** A Ghanaian mobile number as wa.me wants it (digits only, country code 233); other international numbers keep their own code. */
export function whatsappNumber(phone: string | null | undefined): string | null {
  if (!phone) return null
  let d = phone.replace(/[^\d+]/g, '')
  if (d.startsWith('+')) return d.slice(1).replace(/\D/g, '') || null
  d = d.replace(/\D/g, '')
  if (d.startsWith('00')) return d.slice(2) || null
  if (d.startsWith('0') && d.length === 10) return `233${d.slice(1)}`
  if (d.length === 9) return `233${d}`
  return d.length >= 10 ? d : null
}
