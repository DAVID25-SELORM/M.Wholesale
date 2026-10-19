import { downloadDocumentPdf, downloadTablePdf } from '@/lib/pdf'
import type { CreditNote, CreditNoteLine } from '@/services/creditNotes'
import type { Customer, StatementRow } from '@/services/customers'
import type { DeliveryNote, PickLine } from '@/services/deliveries'
import { fmtQty } from '@/services/inventory'
import type { DocLine, Quotation } from '@/services/orders'
import type { Organization } from '@/services/organization'
import { fetchAppSettings } from '@/services/settings'
import { moneyFmt, type SalesInvoice, type SalesInvoiceLine } from '@/services/sales'

const orgBlock = (o: Organization | undefined) => ({
  name: o?.legal_name || o?.name || '',
  lines: [[o?.address, o?.city, o?.region].filter(Boolean).join(', '), [o?.phone, o?.email].filter(Boolean).join(' · '), o?.tax_number ? `Tax no. ${o.tax_number}` : ''],
})
const partyLines = (c: Customer | null | undefined) => [[c?.address, c?.city, c?.region].filter(Boolean).join(', '), c?.licence_number ? `Licence ${c.licence_number}` : '', c?.tax_number ? `Tax no. ${c.tax_number}` : '']
/** The organization's footer line and (on invoices and quotations) payment instructions, as printed notes. */
async function settingNotes(withPayment: boolean): Promise<string[]> {
  const s = await fetchAppSettings()
  return [...(withPayment && typeof s['invoice.payment_instructions'] === 'string' && s['invoice.payment_instructions'] ? [`Payment instructions: ${s['invoice.payment_instructions']}`] : []), ...(typeof s['invoice.footer'] === 'string' && s['invoice.footer'] ? [s['invoice.footer']] : [])]
}
const unitName = (factor: number, base: string | undefined, pack: string | undefined) => (factor === 1 ? base : pack) ?? ''

export async function downloadInvoicePdf(i: { invoice: SalesInvoice; lines: SalesInvoiceLine[]; org: Organization | undefined; customer: Customer | null | undefined }): Promise<void> {
  const inv = i.invoice
  await downloadDocumentPdf({
    kind: inv.status === 'CANCELLED' ? 'CANCELLED' : 'TAX INVOICE', number: inv.invoice_number ?? '', organization: orgBlock(i.org),
    meta: [['Date', inv.invoice_date], ...(inv.due_date ? [['Due', inv.due_date] as [string, string]] : []), ...(inv.customer_reference ? [['Your reference', inv.customer_reference] as [string, string]] : [])],
    party: { heading: 'Bill to', name: inv.customer?.name ?? '', lines: partyLines(i.customer) },
    columns: [{ header: 'Item' }, { header: 'Qty', align: 'right' }, { header: 'Price', align: 'right' }, { header: 'Disc %', align: 'right' }, { header: 'Tax', align: 'right' }, { header: 'Amount', align: 'right' }],
    rows: i.lines.map((l) => [
      `${l.product?.brand_name ?? ''} (${l.product?.sku ?? ''})`,
      `${fmtQty(Number(l.quantity))} ${unitName(Number(l.unit?.factor_to_base ?? 1), l.product?.base_unit?.name, l.unit?.unit?.name)}`,
      moneyFmt(l.unit_price), Number(l.discount_percent) > 0 ? String(Number(l.discount_percent)) : '', Number(l.tax_rate) > 0 ? `${Number(l.tax_rate)}%` : 'Exempt', moneyFmt(l.line_total),
    ]),
    totals: [
      ['Subtotal', moneyFmt(inv.subtotal)], ['Tax', moneyFmt(inv.tax_total)], [`Total (${inv.currency_code})`, moneyFmt(inv.total_amount)],
      ['Paid', moneyFmt(inv.amount_paid)], ...(Number(inv.amount_credited) > 0 ? [['Credited', moneyFmt(inv.amount_credited)] as [string, string]] : []), ['Balance due', moneyFmt(inv.balance_due)],
    ],
    notes: [...(inv.notes ? [inv.notes] : []), ...(await settingNotes(true))], ...(inv.status === 'REVERSED' ? { stamp: 'REVERSED' } : inv.status === 'CANCELLED' ? { stamp: 'CANCELLED' } : {}),
    filename: `invoice-${inv.invoice_number ?? inv.id}`,
  })
}

export async function downloadCreditNotePdf(i: { note: CreditNote; lines: CreditNoteLine[]; org: Organization | undefined; customer: Customer | null | undefined }): Promise<void> {
  const n = i.note
  await downloadDocumentPdf({
    kind: n.status === 'REVERSED' ? 'REVERSED' : 'CREDIT NOTE', number: n.credit_note_number ?? '', organization: orgBlock(i.org),
    meta: [['Date', n.credit_date], ['Invoice', n.invoice?.invoice_number ?? ''], ['Reason', n.reason_code.replace(/_/g, ' ').toLowerCase()]],
    party: { heading: 'Credit to', name: n.customer?.name ?? '', lines: partyLines(i.customer) },
    columns: [{ header: 'Item' }, { header: 'Credit for' }, { header: 'Net', align: 'right' }, { header: 'Tax', align: 'right' }, { header: 'Amount', align: 'right' }],
    rows: i.lines.map((l) => [
      `${l.product?.brand_name ?? ''} (${l.product?.sku ?? ''})`,
      l.line_type === 'RETURN' ? `${fmtQty(Number(l.quantity))} ${unitName(Number(l.unit?.factor_to_base ?? 1), l.product?.base_unit?.name, l.unit?.unit?.name)} returned` : l.description || 'Price correction',
      moneyFmt(l.line_net), moneyFmt(l.line_tax), moneyFmt(l.line_total),
    ]),
    totals: [['Credit before tax', moneyFmt(n.subtotal)], ['Tax', moneyFmt(n.tax_total)], [`Total credit (${n.currency_code})`, moneyFmt(n.total_amount)]],
    notes: [...(n.notes ? [n.notes] : []), ...(await settingNotes(false))], ...(n.status === 'REVERSED' ? { stamp: 'REVERSED' } : {}), filename: `credit-note-${n.credit_note_number ?? n.id}`,
  })
}

export async function downloadQuotationPdf(i: { quotation: Quotation; lines: DocLine[]; org: Organization | undefined; customer: Customer | null | undefined }): Promise<void> {
  const q = i.quotation
  await downloadDocumentPdf({
    kind: 'QUOTATION', number: q.quotation_number ?? '', organization: orgBlock(i.org),
    meta: [['Date', q.quotation_date], ['Valid until', q.valid_until], ...(q.customer_reference ? [['Your reference', q.customer_reference] as [string, string]] : [])],
    party: { heading: 'Prepared for', name: q.customer?.name ?? '', lines: partyLines(i.customer) },
    columns: [{ header: 'Item' }, { header: 'Qty', align: 'right' }, { header: 'Price', align: 'right' }, { header: 'Disc %', align: 'right' }, { header: 'Tax', align: 'right' }, { header: 'Amount', align: 'right' }],
    rows: i.lines.map((l) => [
      `${l.product?.brand_name ?? ''} (${l.product?.sku ?? ''})`,
      `${fmtQty(Number(l.quantity))} ${unitName(Number(l.unit?.factor_to_base ?? 1), l.product?.base_unit?.name, l.unit?.unit?.name)}`,
      moneyFmt(l.unit_price), Number(l.discount_percent) > 0 ? String(Number(l.discount_percent)) : '', Number(l.tax_rate) > 0 ? `${Number(l.tax_rate)}%` : 'Exempt', moneyFmt(l.line_total),
    ]),
    totals: [['Subtotal', moneyFmt(q.subtotal)], ['Tax', moneyFmt(q.tax_total)], [`Total (${q.currency_code})`, moneyFmt(q.total_amount)]],
    notes: [...(q.notes ? [q.notes] : []), 'Prices are for the quantities shown and subject to stock on acceptance.', ...(await settingNotes(true))], filename: `quotation-${q.quotation_number ?? q.id}`,
  })
}

export async function downloadStatementPdf(i: { customerName: string; organization: string; rows: StatementRow[] }): Promise<void> {
  const last = i.rows[i.rows.length - 1]
  await downloadTablePdf({
    title: `Statement of account: ${i.customerName}`, subtitle: `Printed ${new Date().toLocaleDateString()}`, organization: i.organization, filename: `statement-${i.customerName.replace(/[^\w]+/g, '-').toLowerCase()}`,
    columns: [{ header: 'Date' }, { header: 'Type' }, { header: 'Document' }, { header: 'Details' }, { header: 'Debit', align: 'right' }, { header: 'Credit', align: 'right' }, { header: 'Balance', align: 'right' }],
    rows: i.rows.map((r) => [r.entry_date, r.entry_type.replace(/_/g, ' ').toLowerCase(), r.reference, r.description, r.debit > 0 ? moneyFmt(r.debit) : '', r.credit > 0 ? moneyFmt(r.credit) : '', moneyFmt(r.balance)]),
    footer: last ? [['', '', '', 'Balance (positive = the customer owes us)', '', '', moneyFmt(last.balance)]] : undefined,
  })
}

export async function downloadDeliveryNotePdf(i: { note: DeliveryNote; lines: PickLine[]; org: Organization | undefined }): Promise<void> {
  const n = i.note
  await downloadDocumentPdf({
    kind: 'DELIVERY NOTE', number: n.note_number, organization: orgBlock(i.org),
    meta: [['Invoice', n.invoice?.invoice_number ?? ''], ['Packages', String(n.packages)], ...(n.driver_name ? [['Driver', `${n.driver_name}${n.vehicle_number ? ` / ${n.vehicle_number}` : ''}`] as [string, string]] : [])],
    party: { heading: 'Deliver to', name: n.customer?.name ?? '', lines: [n.delivery_address ?? '', [n.contact_name, n.contact_phone].filter(Boolean).join(' · ')] },
    columns: [{ header: 'Location' }, { header: 'Item' }, { header: 'Batch' }, { header: 'Expiry' }, { header: 'Pick', align: 'right' }, { header: 'Ordered', align: 'right' }],
    rows: i.lines.map((l) => [l.location_code ?? '', `${l.product_name} (${l.sku})`, l.batch_number ?? '', l.expiry_date ?? '', `${fmtQty(l.base_quantity)} ${l.base_unit}`, `${fmtQty(l.line_quantity)} ${l.line_unit}`]),
    totals: [['Packages', String(n.packages)]],
    notes: [n.notes ?? '', 'Picked by: ____________________     Received by: ____________________     Signature / date: ____________________', ...(await settingNotes(false))].filter(Boolean),
    ...(n.status === 'CANCELLED' ? { stamp: 'CANCELLED' } : {}), filename: `delivery-note-${n.note_number}`,
  })
}
