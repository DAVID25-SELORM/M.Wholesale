import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBranch, addSupplier, addUser, addWarehouse, admin, closePool, createOrg, withUser, type Org } from '../helpers/db'

// Cutover tools: importing customers, and carrying over unpaid customer and supplier invoices as opening balances.

let a: Org
let b: Org
let owner: string
let accounts: string   // ACCOUNTS_MANAGER: opening.balances
let salesMgr: string   // SALES_MANAGER: customers.create, no opening.balances
let cashier: string

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
type Out = { ok: true; rows: any[] } | { ok: false; code: string; message: string }
const call = (user: string, sql: string, params: unknown[] = []): Promise<Out> => withUser(user, (c) => c.attempt(sql, params), { commit: true }) as Promise<Out>
const ok = async (p: Promise<Out>) => { const r = await p; if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`); return r.rows[0] }
const failure = async (p: Promise<Out>) => { const r = await p; return r.ok ? { code: 'ok', message: '' } : { code: r.code, message: r.message } }
const code = async (p: Promise<Out>) => (await failure(p)).code
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows
const num = (v: unknown) => Number(v)

const imp = (user: string, fn: string, rows: object[], dry = false) =>
  call(user, `select public.${fn}($1::jsonb, $2) as r`, [JSON.stringify(rows), dry])
const result = async (p: Promise<Out>) => (await ok(p)).r as { row: number; key: string; status: string; message: string | null }[]
const customerId = async (c: string) => (await q(`select id from public.customers where organization_id = $1 and code = $2`, [a.id, c]))[0].id as string
const invoiceOf = async (ref: string) => (await q(`select * from public.sales_invoices where organization_id = $1 and invoice_number = $2`, [a.id, `OB-${ref}`]))[0]

beforeAll(async () => {
  a = await createOrg('CUT-A')
  b = await createOrg('CUT-B')
  await addWarehouse(a.id, a.hq, 'W1')
  await addBranch(a.id, 'B2')
  owner = a.ownerId
  accounts = await addUser(a.id, 'ACCOUNTS_MANAGER')
  salesMgr = await addUser(a.id, 'SALES_MANAGER')
  cashier = await addUser(a.id, 'CASHIER')
  await addSupplier(a.id, 'SUP1', 'Opening Supplier Ltd')
})
afterAll(closePool)

describe('import customers', () => {
  const rows = [
    { code: 'adom', name: 'Adom Pharmacy', customer_type: 'PHARMACY', licence_number: 'PC/1', licence_expiry: day(300), payment_terms_days: '30', credit_limit: '5000', controlled_drugs_authorised: 'yes' },
    { code: 'KORLE', name: 'Korle Clinic', customer_type: 'clinic', payment_terms_days: '14', credit_limit: '2000' },
  ]
  it('checks every row without saving on a dry run, and refuses people without the right', async () => {
    expect(await code(imp(cashier, 'import_customers', rows, true))).toBe('42501')
    const r = await result(imp(salesMgr, 'import_customers', rows, true))
    expect(r.map((x) => [x.key, x.status])).toEqual([['ADOM', 'VALID'], ['KORLE', 'VALID']])
    expect(num((await q(`select count(*) n from public.customers where organization_id = $1 and code in ('ADOM', 'KORLE')`, [a.id]))[0].n)).toBe(0)
  })
  it('creates the customers, leaves existing ones alone, and explains bad rows', async () => {
    const r = await result(imp(salesMgr, 'import_customers', [...rows, { code: 'BAD 1', name: 'x' }, { code: 'ODD', name: 'Odd Ltd', customer_type: 'SPACESHIP' }, { code: 'ADOM', name: 'dup' }]))
    expect(r.map((x) => x.status)).toEqual(['CREATED', 'CREATED', 'ERROR', 'ERROR', 'ERROR'])
    expect(r[2]!.message).toMatch(/customer code is missing or not valid/)
    expect(r[3]!.message).toMatch(/unknown customer type/)
    expect(r[4]!.message).toMatch(/more than once/)
    expect(await q(`select code, customer_type, credit_limit::float8 cl, payment_terms_days pt, controlled_drugs_authorised ca from public.customers where organization_id = $1 and code in ('ADOM', 'KORLE') order by code`, [a.id]))
      .toEqual([{ code: 'ADOM', customer_type: 'PHARMACY', cl: 5000, pt: 30, ca: true }, { code: 'KORLE', customer_type: 'CLINIC', cl: 2000, pt: 14, ca: false }])
    const again = await result(imp(salesMgr, 'import_customers', rows))
    expect(again.map((x) => x.status)).toEqual(['EXISTS', 'EXISTS'])
    expect((await q(`select count(*)::int n from public.audit_logs where action = 'customer.imported' and organization_id = $1`, [a.id]))[0].n).toBe(2)
  })
})

describe('opening receivables', () => {
  const rows = [
    { customer_code: 'ADOM', reference: 'inv-1001', invoice_date: day(-40), due_date: day(-10), amount: '1200.50', notes: 'From the old system' },
    { customer_code: 'ADOM', reference: 'INV-1002', invoice_date: day(-5), amount: '300' },
    { customer_code: 'KORLE', reference: 'K-77', invoice_date: day(-60), amount: '999.99' },
  ]
  it('needs the opening-balance right, checks on a dry run, and then creates posted invoices with no stock behind them', async () => {
    expect(await code(imp(salesMgr, 'import_opening_receivables', rows, true))).toBe('42501')
    expect(await code(imp(cashier, 'import_opening_receivables', rows))).toBe('42501')
    const dry = await result(imp(accounts, 'import_opening_receivables', rows, true))
    expect(dry.map((x) => x.status)).toEqual(['VALID', 'VALID', 'VALID'])
    expect(await invoiceOf('INV-1001')).toBeUndefined()
    const r = await result(imp(accounts, 'import_opening_receivables', rows))
    expect(r.map((x) => x.status)).toEqual(['CREATED', 'CREATED', 'CREATED'])
    const i = await invoiceOf('INV-1001')
    expect(i).toMatchObject({ status: 'POSTED', is_opening: true, stock_document_id: null, customer_reference: 'Opening balance, INV-1001', branch_id: a.hq })
    expect([num(i.total_amount), num(i.balance_due)]).toEqual([1200.5, 1200.5])
    expect(i.due_date.toISOString().slice(0, 10)).toBe(day(-10))
    expect((await invoiceOf('INV-1002')).due_date.toISOString().slice(0, 10)).toBe(day(25))          // invoice date + the customer's 30 days
    expect((await q(`select count(*)::int n from public.sales_invoice_lines where sales_invoice_id = $1`, [i.id]))[0].n).toBe(0)
  })

  it('refuses doubles, unknown customers and silly values, one row at a time', async () => {
    const r = await result(imp(accounts, 'import_opening_receivables', [
      { customer_code: 'ADOM', reference: 'INV-1001', invoice_date: day(-40), amount: '5' },
      { customer_code: 'NOBODY', reference: 'X1', invoice_date: day(-1), amount: '5' },
      { customer_code: 'ADOM', reference: 'X2', invoice_date: day(-1), amount: '0' },
      { customer_code: 'ADOM', reference: 'X3', invoice_date: day(-1), amount: '10.123' },
      { customer_code: 'ADOM', reference: 'X4', invoice_date: day(3), amount: '10' },
      { customer_code: 'ADOM', reference: 'X5', invoice_date: day(-10), due_date: day(-20), amount: '10' },
      { customer_code: 'ADOM', reference: 'X6', invoice_date: day(-1), amount: '10', branch: 'ZZZ' },
      { customer_code: 'ADOM', reference: 'X7', invoice_date: day(-1), amount: '10', branch: 'B2' },
      { customer_code: 'ADOM', reference: '', invoice_date: day(-1), amount: '10' },
    ]))
    expect(r.map((x) => x.status)).toEqual(Array(9).fill('ERROR'))
    expect(r[0]!.message).toMatch(/already imported/)
    expect(r[1]!.message).toMatch(/not on file: import the customers first/)
    expect(r[2]!.message).toMatch(/above 0/)
    expect(r[3]!.message).toMatch(/2 decimals/)
    expect(r[4]!.message).toMatch(/sensible past date/)
    expect(r[5]!.message).toMatch(/due date is before/)
    expect(r[6]!.message).toMatch(/branch "ZZZ" is not on file/)
    expect(r[7]!.message).toMatch(/no active warehouse/)                                                 // branch 2 has none yet
    expect(r[8]!.message).toMatch(/reference is missing/)
    expect(num((await q(`select count(*) n from public.sales_invoices where organization_id = $1 and is_opening`, [a.id]))[0].n)).toBe(3)
  })

  it('behaves like any invoice for the customer: owed, on the statement, overdue, and paid by a receipt', async () => {
    const adom = await customerId('ADOM')
    const credit = (await ok(call(owner, `select * from public.customer_credit($1)`, [adom])))
    expect(num(credit.outstanding)).toBe(1500.5)
    const overdue = await withUser(owner, async (c) => (await c.q(`select customer_name, outstanding::float8 o from public.receivables_summary() order by customer_name`)).rows)
    expect(overdue).toEqual([{ customer_name: 'Adom Pharmacy', o: 1500.5 }, { customer_name: 'Korle Clinic', o: 999.99 }])
    const st = await withUser(owner, async (c) => (await c.q(`select entry_type, debit::float8 d, balance::float8 b from public.customer_statement($1) order by entry_date, entry_type`, [adom])).rows)
    expect(st.map((x) => x.d).sort((x, y) => x - y)).toEqual([300, 1200.5])
    expect(st[st.length - 1]!.b).toBe(1500.5)
    const reminders = await withUser(owner, async (c) => (await c.q(`select customer_name, overdue_amount::float8 o from public.overdue_customers(1) order by customer_name`)).rows)
    expect(reminders).toEqual([{ customer_name: 'Adom Pharmacy', o: 1200.5 }, { customer_name: 'Korle Clinic', o: 999.99 }])
    await ok(call(owner, `select public.record_receipt($1, $2, 500, 'CASH', null, null) as r`, [adom, a.hq]))
    expect(num((await invoiceOf('INV-1001')).balance_due)).toBe(700.5)                                  // the receipt went to the oldest invoice
  })

  it('refuses everything that needs stock, and stays out of sales and VAT reports', async () => {
    const i = await invoiceOf('INV-1002')
    expect((await call(owner, `select public.reverse_sales_invoice($1, 'Cancelled by mistake')`, [i.id])).ok).toBe(false)          // no lines, no stock: refused (the screen does not offer the button)
    expect((await q(`select status from public.sales_invoices where id = $1`, [i.id]))[0].status).toBe('POSTED')
    expect((await failure(call(owner, `select public.prepare_delivery_note($1, null, null, null, 1, null)`, [i.id]))).message).toMatch(/opening balance carried over/)
    expect((await call(owner, `select public.save_credit_note(null, $1, null, 'OTHER', null, $2::jsonb)`, [i.id, JSON.stringify([{ type: 'PRICE', invoice_line_id: i.id, amount: 1 }])])).ok).toBe(false)
    const sales = await withUser(owner, async (c) => (await c.q(`select count(*)::int n from public.sales_report(current_date - 365, current_date, 'DAY', null)`)).rows[0].n)
    expect(sales).toBe(0)
    const vat = await withUser(owner, async (c) => (await c.q(`select count(*)::int n from public.vat_report(current_date - 365, current_date, null)`)).rows[0].n)
    expect(vat).toBe(0)
  })
})

describe('opening payables', () => {
  const rows = [
    { supplier_code: 'sup1', reference: 'SI-9001', invoice_date: day(-30), due_date: day(-2), amount: '2500' },
    { supplier_code: 'SUP1', reference: 'SI-9002', invoice_date: day(-3), amount: '800.25', notes: 'Part shipment' },
  ]
  it('creates approved, unpaid supplier invoices that can be paid like any other', async () => {
    expect(await code(imp(salesMgr, 'import_opening_payables', rows))).toBe('42501')
    const r = await result(imp(accounts, 'import_opening_payables', rows))
    expect(r.map((x) => x.status)).toEqual(['CREATED', 'CREATED'])
    const [inv] = await q(`select * from public.supplier_invoices where organization_id = $1 and supplier_invoice_number = 'SI-9001'`, [a.id])
    expect(inv).toMatchObject({ status: 'APPROVED', is_opening: true, purchase_order_id: null, branch_id: a.hq })
    expect(inv.invoice_number).toMatch(/^SIN-/)
    expect([num(inv.subtotal), num(inv.total_amount)]).toEqual([2500, 2500])
    const owed = await withUser(owner, async (c) => (await c.q(`select supplier_name, outstanding::float8 o, overdue_1_30::float8 od from public.payables_summary()`)).rows)
    expect(owed).toEqual([{ supplier_name: 'Opening Supplier Ltd', o: 3300.25, od: 2500 }])
    await ok(call(accounts, `select public.pay_supplier_invoice($1, current_date, 'CHQ-OB-1')`, [inv.id]))
    expect((await q(`select status from public.supplier_invoices where id = $1`, [inv.id]))[0].status).toBe('PAID')
  })
  it('refuses doubles and unknown suppliers', async () => {
    const r = await result(imp(accounts, 'import_opening_payables', [
      { supplier_code: 'SUP1', reference: 'SI-9002', invoice_date: day(-3), amount: '5' },
      { supplier_code: 'NOPE', reference: 'Z1', invoice_date: day(-3), amount: '5' },
      { supplier_code: 'SUP1', reference: 'Z2', invoice_date: day(-3), amount: '-5' },
    ]))
    expect(r.map((x) => x.status)).toEqual(['ERROR', 'ERROR', 'ERROR'])
    expect(r[0]!.message).toMatch(/already on file/)
    expect(r[1]!.message).toMatch(/not on file: import the suppliers first/)
  })
})

describe('removing a wrong opening invoice', () => {
  it('works before accounting starts, with a reason, and not once money was applied', async () => {
    const r = await result(imp(accounts, 'import_opening_receivables', [{ customer_code: 'KORLE', reference: 'OOPS-1', invoice_date: day(-9), amount: '10' }]))
    expect(r[0]!.status).toBe('CREATED')
    const wrong = await invoiceOf('OOPS-1')
    expect(await code(call(salesMgr, `select public.remove_opening_balance('RECEIVABLE', $1, 'Typed twice')`, [wrong.id]))).toBe('42501')
    expect(await code(call(accounts, `select public.remove_opening_balance('RECEIVABLE', $1, 'x')`, [wrong.id]))).toBe('22023')
    await ok(call(accounts, `select public.remove_opening_balance('RECEIVABLE', $1, 'Typed twice by mistake')`, [wrong.id]))
    expect(await invoiceOf('OOPS-1')).toMatchObject({ status: 'REVERSED', reversal_reason: 'Typed twice by mistake' })
    expect((await failure(call(accounts, `select public.remove_opening_balance('RECEIVABLE', $1, 'Again please')`, [wrong.id]))).message).toMatch(/already reversed/)
    const paid = await invoiceOf('INV-1001')
    expect((await failure(call(accounts, `select public.remove_opening_balance('RECEIVABLE', $1, 'Customer disputes it')`, [paid.id]))).message).toMatch(/payments have been applied/)
    const p = await result(imp(accounts, 'import_opening_payables', [{ supplier_code: 'SUP1', reference: 'OOPS-2', invoice_date: day(-9), amount: '10' }]))
    expect(p[0]!.status).toBe('CREATED')
    const [si] = await q(`select id from public.supplier_invoices where organization_id = $1 and supplier_invoice_number = 'OOPS-2'`, [a.id])
    await ok(call(accounts, `select public.remove_opening_balance('PAYABLE', $1, 'Not ours, wrong supplier')`, [si.id]))
    expect((await q(`select status from public.supplier_invoices where id = $1`, [si.id]))[0].status).toBe('CANCELLED')
  })
})

describe('with accounting', () => {
  it('carries opening invoices in the opening balances: never journalled, paid later like any other, and no more imports or removals', async () => {
    const sug = await withUser(owner, async (c) => (await c.q(`select code, suggested::float8 s from public.suggest_opening_balances() order by code`)).rows)
    expect(Object.fromEntries(sug.map((x) => [x.code, x.s]))).toMatchObject({ '1100': 2000.49, '2000': 800.25 })
    const lines = (await withUser(owner, async (c) => (await c.q(`select account_id, code, suggested::float8 s from public.suggest_opening_balances()`)).rows))
      .filter((x) => x.s > 0).map((x) => ({ account_id: x.account_id, debit: x.code === '1100' ? x.s : 0, credit: x.code === '2000' ? x.s : 0 }))
    await ok(call(owner, `select public.start_accounting(current_date, $1::jsonb)`, [JSON.stringify(lines)]))
    expect((await q(`select count(*)::int n from public.gl_journals where organization_id = $1 and source_type in ('SALES_INVOICE', 'SUPPLIER_INVOICE')`, [a.id]))[0].n).toBe(0)
    const checks = async () => (await withUser(owner, async (c) => (await c.q(`select check_code, difference::float8 d from public.accounting_checks() order by 1`)).rows))
    expect(await checks()).toEqual([{ check_code: 'AP', d: 0 }, { check_code: 'AR', d: 0 }, { check_code: 'INVENTORY', d: 0 }, { check_code: 'TRIAL', d: 0 }])
    // a customer pays an opening invoice and the supplier is paid: both reach the ledger, and the books still agree with the records
    const korle = await customerId('KORLE')
    await ok(call(owner, `select public.record_receipt($1, $2, 999.99, 'CASH', null, null) as r`, [korle, a.hq]))
    const [si] = await q(`select id from public.supplier_invoices where organization_id = $1 and supplier_invoice_number = 'SI-9002'`, [a.id])
    await ok(call(accounts, `select public.pay_supplier_invoice($1, current_date, 'CHQ-OB-2')`, [si.id]))
    expect(await checks()).toEqual([{ check_code: 'AP', d: 0 }, { check_code: 'AR', d: 0 }, { check_code: 'INVENTORY', d: 0 }, { check_code: 'TRIAL', d: 0 }])
    // nothing more can be imported or removed: the ledger already carries these balances
    expect((await failure(imp(accounts, 'import_opening_receivables', [{ customer_code: 'ADOM', reference: 'LATE-1', invoice_date: day(-1), amount: '5' }]))).code).toBe('55000')
    expect((await failure(imp(accounts, 'import_opening_payables', [{ supplier_code: 'SUP1', reference: 'LATE-2', invoice_date: day(-1), amount: '5' }]))).code).toBe('55000')
    const i = await invoiceOf('INV-1002')
    expect((await failure(call(accounts, `select public.remove_opening_balance('RECEIVABLE', $1, 'Changed our mind')`, [i.id]))).code).toBe('55000')
  })
})

describe('isolation', () => {
  it('keeps organizations apart', async () => {
    expect(await code(imp(b.ownerId, 'import_opening_receivables', [{ customer_code: 'ADOM', reference: 'B-1', invoice_date: day(-1), amount: '5' }]))).toBe('ok')   // the row fails, not the call
    const r = await result(imp(b.ownerId, 'import_opening_receivables', [{ customer_code: 'ADOM', reference: 'B-1', invoice_date: day(-1), amount: '5' }]))
    expect(r[0]!.status).toBe('ERROR')                                                                    // ADOM belongs to organization A
    expect(num((await q(`select count(*) n from public.sales_invoices where organization_id = $1`, [b.id]))[0].n)).toBe(0)
  })
})
