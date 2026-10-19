import { useQuery } from '@tanstack/react-query'
import { formatDateTime } from '@/lib/utils'
import { getOrganization } from '@/services/organization'
import type { CheckoutResult } from '@/services/pos'
import { RECEIPT_METHOD_LABEL, getSalesInvoice, listInvoicePayments, listSalesLines, moneyFmt, type ReceiptMethod } from '@/services/sales'
import { useAppSettings } from '@/modules/settings/useAppSettings'

/** A narrow till receipt (80 mm). Wrapped in #print-area by the caller, so window.print() prints only this. */
export function PosReceipt({ sale }: { sale: CheckoutResult }) {
  const org = useQuery({ queryKey: ['organization'], queryFn: getOrganization, staleTime: 5 * 60_000 })
  const inv = useQuery({ queryKey: ['sales-invoice', sale.invoice_id], queryFn: () => getSalesInvoice(sale.invoice_id) })
  const lines = useQuery({ queryKey: ['sales-invoice-lines', sale.invoice_id], queryFn: () => listSalesLines(sale.invoice_id) })
  const pays = useQuery({ queryKey: ['invoice-payments', sale.invoice_id], queryFn: () => listInvoicePayments(sale.invoice_id) })
  const o = org.data
  const settings = useAppSettings()
  const i = inv.data
  return (
    <div id="print-area" className="receipt-80 mx-auto w-full max-w-[80mm] bg-white p-3 font-mono text-xs leading-relaxed text-slate-900">
      <p className="text-center text-sm font-bold">{o?.trading_name || o?.legal_name || o?.name || ''}</p>
      <p className="text-center">{[o?.address, o?.city].filter(Boolean).join(', ')}</p>
      {o?.phone && <p className="text-center">Tel {o.phone}</p>}
      {o?.tax_number && <p className="text-center">Tax no. {o.tax_number}</p>}
      <p className="mt-2 border-t border-dashed border-slate-400 pt-2">Receipt {sale.invoice_number}</p>
      <p>{formatDateTime(i?.posted_at ?? new Date().toISOString())}</p>
      {i?.customer && i.customer.code !== 'WALKIN' && <p>Customer: {i.customer.name}</p>}
      <table className="mt-2 w-full">
        <tbody>
          {(lines.data ?? []).map((l) => (
            <tr key={l.id} className="align-top">
              <td className="pr-1">{l.product?.brand_name}<br /><span className="text-slate-600">{Number(l.quantity)} × {moneyFmt(l.unit_price)}{Number(l.discount_percent) > 0 ? ` -${Number(l.discount_percent)}%` : ''}</span></td>
              <td className="text-right">{moneyFmt(l.line_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 space-y-0.5 border-t border-dashed border-slate-400 pt-2">
        {i && Number(i.tax_total) > 0 && <p className="flex justify-between"><span>Tax included</span><span>{moneyFmt(i.tax_total)}</span></p>}
        <p className="flex justify-between text-sm font-bold"><span>TOTAL</span><span>{moneyFmt(sale.total_amount)}</span></p>
        {(pays.data ?? []).map((p) => (
          <p key={p.id} className="flex justify-between"><span>{RECEIPT_METHOD_LABEL[(p.receipt?.method ?? 'CASH') as ReceiptMethod]}</span><span>{moneyFmt(p.amount)}</span></p>
        ))}
        {sale.cash_tendered > 0 && <p className="flex justify-between"><span>Cash handed over</span><span>{moneyFmt(sale.cash_tendered)}</span></p>}
        {sale.change > 0 && <p className="flex justify-between font-bold"><span>Change</span><span>{moneyFmt(sale.change)}</span></p>}
        {sale.owed > 0 && <p className="flex justify-between font-bold"><span>On account</span><span>{moneyFmt(sale.owed)}</span></p>}
      </div>
      <p className="mt-3 whitespace-pre-line text-center">{settings.invoiceFooter || 'Thank you'}</p>
    </div>
  )
}
