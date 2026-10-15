import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBranch, addProduct, addUser, addWarehouse, admin, closePool, createOrg, rand, withUser, type Org } from '../helpers/db'

let a: Org
let b: Org
let wh: string
let branch2: string
let wh2: string
let owner: string
let accountsMgr: string   // reports.sales + reports.margins + reminders.send
let accountsOfficer: string   // reports.sales (NO margins), reminders.send
let officer2: string      // reports.sales, branch 2 only
let rep: string           // no reports, reminders.view only
let pharmacist: string    // registers.controlled
let pharmacist2: string   // registers.controlled, branch 2 only
let defaultList: string

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  a = await createOrg('RPT-A')
  b = await createOrg('RPT-B')
  wh = await addWarehouse(a.id, a.hq, 'W1')
  branch2 = await addBranch(a.id, 'B2')
  wh2 = await addWarehouse(a.id, branch2, 'W2')
  owner = a.ownerId
  accountsMgr = await addUser(a.id, 'ACCOUNTS_MANAGER')
  accountsOfficer = await addUser(a.id, 'ACCOUNTS_OFFICER')
  officer2 = await addUser(a.id, 'ACCOUNTS_OFFICER', branch2)
  rep = await addUser(a.id, 'SALES_REP')
  pharmacist = await addUser(a.id, 'PHARMACIST')
  pharmacist2 = await addUser(a.id, 'PHARMACIST', branch2)
  defaultList = (await q(`insert into public.price_lists (organization_id, code, name, is_default) values ($1, 'RETAIL', 'Retail', true) returning id`, [a.id]))[0].id
})
afterAll(closePool)

type Out = { ok: true; rows: any[] } | { ok: false; code: string; message: string }
const call = (user: string, sql: string, params: unknown[] = []): Promise<Out> => withUser(user, (c) => c.attempt(sql, params), { commit: true }) as Promise<Out>
const ok = async (p: Promise<Out>) => {
  const r = await p
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`)
  return r
}
const rows = async (p: Promise<Out>) => (await ok(p)).rows
const failure = async (p: Promise<Out>) => { const r = await p; return r.ok ? { code: 'ok', message: '' } : { code: r.code, message: r.message } }
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows
const num = (v: unknown) => Number(v)

async function addCustomer(o: { controlled?: boolean } = {}): Promise<string> {
  return (await q(
    `insert into public.customers (organization_id, code, name, customer_type, licence_number, licence_expiry, controlled_drugs_authorised, payment_terms_days, credit_limit)
     values ($1, $2, $3, 'PHARMACY', $4, $5, $6, 30, 1000000) returning id`, [a.id, `C${rand()}`, `Customer ${rand()}`, `PC/${rand()}`, day(300), o.controlled ?? false]))[0].id
}
/** A product priced `price` per unit with `qty` in stock at `wh`, bought at `cost` (null = no cost on record). */
async function stocked(o: { price: number; cost: number | null; qty?: number; cls?: string; warehouse?: string }) {
  const product = await addProduct(a.id, { cls: o.cls ?? 'GSL' })
  await q(`insert into public.price_list_items (organization_id, price_list_id, product_id, product_unit_id, unit_price) values ($1, $2, $3, $4, $5)`, [a.id, defaultList, product.id, product.baseUnitRowId, o.price])
  await ok(call(owner, `select public.post_stock_document('OPENING', $1, $2::jsonb) as r`, [o.warehouse ?? wh, JSON.stringify([{ product_id: product.id, quantity: o.qty ?? 1000, batch_number: `B${rand()}`, expiry_date: day(300), ...(o.cost !== null ? { unit_cost: o.cost } : {}) }])]))
  return product
}
async function invoice(customer: string, lines: { product: string; qty: number }[], warehouse = wh): Promise<string> {
  const id = (await rows(call(owner, `select public.save_sales_invoice(null, $1, $2, null, null, $3::jsonb) as id`, [customer, warehouse, JSON.stringify(lines.map((l) => ({ product_id: l.product, quantity: l.qty })))])))[0].id
  await ok(call(owner, `select public.post_sales_invoice($1) as r`, [id]))
  return id
}
const report = (user: string, group: string, from = day(-1), to = day(1), branch: string | null = null) =>
  call(user, `select group_key, group_label, invoices::int inv, units::float8 units, sales::float8 sales, credits::float8 credits, net_sales::float8 net, tax::float8 tax,
              cost::float8 cost, margin::float8 margin, margin_pct::float8 pct, uncosted_lines::int unc from public.sales_report($1, $2, $3, $4)`, [from, to, group, branch])

describe('sales report with margins', () => {
  it('totals revenue net of credit notes, takes cost from what was picked, and returns restocked goods’ cost', async () => {
    const A = await stocked({ price: 10, cost: 4 })
    const B = await stocked({ price: 5, cost: 2 })
    const c1 = await addCustomer(); const c2 = await addCustomer()
    const i1 = await invoice(c1, [{ product: A.id, qty: 10 }, { product: B.id, qty: 20 }])         // 100 + 100
    await invoice(c2, [{ product: A.id, qty: 5 }])                                                    // 50
    const [l] = await q(`select id from public.sales_invoice_lines where sales_invoice_id = $1 and product_id = $2`, [i1, A.id])
    const n = (await rows(call(owner, `select public.save_credit_note(null, $1, null, 'DAMAGED', null, $2::jsonb) as id`, [i1, JSON.stringify([{ type: 'RETURN', invoice_line_id: l.id, quantity: 2 }])])))[0].id
    await ok(call(owner, `select public.post_credit_note($1) as r`, [n]))                            // 2 x 10 = 20 credited, 2 x 4 = 8 of cost back (quarantined)

    const byProduct = await rows(report(accountsMgr, 'PRODUCT'))
    const rowA = byProduct.find((r) => r.group_key === A.id)
    const bRow = byProduct.find((r) => r.group_key === B.id)
    expect(byProduct.filter((r) => [A.id, B.id].includes(r.group_key))).toHaveLength(2)
    expect(rowA).toMatchObject({ inv: 2, units: 13, sales: 150, credits: 20, net: 130, cost: 52, margin: 78, pct: 60 })   // cost 15x4 - 2x4
    expect(bRow).toMatchObject({ inv: 1, units: 20, sales: 100, credits: 0, net: 100, cost: 40, margin: 60, pct: 60 })
    const total = (await rows(report(accountsMgr, 'DAY')))
    expect(total).toHaveLength(1)
    expect(total[0]).toMatchObject({ inv: 2, sales: 250, credits: 20, net: 230, cost: 92, margin: 138, pct: 60 })
    expect((await rows(report(accountsMgr, 'MONTH')))[0].group_key).toMatch(/^\d{4}-\d{2}$/)
    const byCustomer = await rows(report(accountsMgr, 'CUSTOMER'))
    expect(byCustomer.map((r) => [r.group_key, r.net])).toEqual([[c1, 180], [c2, 50]])                    // c1: 200 - 20, ordered by net sales
    expect((await rows(report(accountsMgr, 'BRANCH')))[0]).toMatchObject({ group_key: a.hq, net: 230 })
    expect((await rows(report(accountsMgr, 'CATEGORY'))).length).toBeGreaterThan(0)
    // dates outside the range give nothing, a reversed invoice disappears
    expect(await rows(report(accountsMgr, 'DAY', day(-30), day(-10)))).toEqual([])
    const i3 = await invoice(c2, [{ product: B.id, qty: 10 }])
    expect(num((await rows(report(accountsMgr, 'DAY')))[0].sales)).toBe(300)
    await ok(call(owner, `select public.reverse_sales_invoice($1, 'Wrong customer') as r`, [i3]))
    expect(num((await rows(report(accountsMgr, 'DAY')))[0].sales)).toBe(250)
  })

  it('shows cost and margin only to people with reports.margins, and only rows of their branches', async () => {
    const P = await stocked({ price: 10, cost: 6 })
    const c = await addCustomer()
    await invoice(c, [{ product: P.id, qty: 10 }])
    const mine = (await rows(report(accountsOfficer, 'PRODUCT'))).find((r) => r.group_key === P.id)
    expect(mine).toMatchObject({ sales: 100, net: 100, cost: null, margin: null, pct: null, unc: null })   // revenue yes, cost no
    expect((await rows(report(accountsMgr, 'PRODUCT'))).find((r) => r.group_key === P.id)).toMatchObject({ cost: 60, margin: 40, pct: 40 })
    expect((await rows(report(officer2, 'PRODUCT'))).find((r) => r.group_key === P.id)).toBeUndefined()    // branch 2 only: no branch 1 rows
    expect((await failure(report(rep, 'DAY'))).code).toBe('42501')
    expect((await failure(report(pharmacist, 'DAY'))).code).toBe('42501')
    expect((await rows(report(accountsMgr, 'PRODUCT', day(-1), day(1), a.hq))).find((r) => r.group_key === P.id)).toBeDefined()
    expect((await rows(report(accountsMgr, 'PRODUCT', day(-1), day(1), branch2))).find((r) => r.group_key === P.id)).toBeUndefined()
    expect(await rows(report(b.ownerId, 'DAY'))).toEqual([])                                            // another organization sees none of it
  })

  it('counts lines without a recorded cost as uncosted, and rejects bad input', async () => {
    const U = await stocked({ price: 10, cost: null })
    const c = await addCustomer()
    await invoice(c, [{ product: U.id, qty: 5 }])
    const r = (await rows(report(owner, 'PRODUCT'))).find((x) => x.group_key === U.id)
    expect(r).toMatchObject({ sales: 50, cost: 0, margin: 50, unc: 1 })
    expect((await failure(report(owner, 'WEEK'))).code).toBe('22023')
    expect((await failure(report(owner, 'DAY', day(1), day(-1)))).code).toBe('22023')
    expect((await failure(report(owner, 'DAY', '2000-01-01', day(0)))).code).toBe('22023')
  })
})

describe('controlled-drugs register', () => {
  it('lists every movement with a running balance, the customer and their licence, the invoice and who posted it; status changes are left out', async () => {
    const C = await stocked({ price: 50, cost: 20, qty: 100, cls: 'CONTROLLED' })
    const authorised = await addCustomer({ controlled: true })
    const i = await invoice(authorised, [{ product: C.id, qty: 10 }])
    const [l] = await q(`select id from public.sales_invoice_lines where sales_invoice_id = $1`, [i])
    const n = (await rows(call(owner, `select public.save_credit_note(null, $1, null, 'DAMAGED', null, $2::jsonb) as id`, [i, JSON.stringify([{ type: 'RETURN', invoice_line_id: l.id, quantity: 3 }])])))[0].id
    await ok(call(owner, `select public.post_credit_note($1) as r`, [n]))
    const bal = (await q(`select batch_id from public.stock_balances where product_id = $1 and stock_status = 'QUARANTINE'`, [C.id]))[0]
    await ok(call(owner, `select public.post_stock_document('STATUS_CHANGE', $1, $2::jsonb, null, 'QUALITY_RELEASE') as r`, [wh, JSON.stringify([{ product_id: C.id, batch_id: bal.batch_id, quantity: 3, status: 'QUARANTINE', to_status: 'AVAILABLE' }])]))
    await ok(call(owner, `select public.post_stock_document('ADJUSTMENT', $1, $2::jsonb, null, 'DAMAGE') as r`, [wh, JSON.stringify([{ product_id: C.id, batch_id: bal.batch_id, quantity: 1, direction: 'OUT' }])]))

    const reg = await rows(call(pharmacist, `select line_no::int n, is_opening, document_number, movement_type, quantity::float8 q, balance::float8 bal, counterparty, licence_number, reference, posted_by_name, batch_number from public.controlled_drug_register($1, $2, $3)`, [C.id, day(0), day(0)]))
    expect(reg.map((r) => [r.movement_type, r.q, r.bal])).toEqual([['OPENING_BALANCE', null, 0], ['OPENING', 100, 100], ['SALE_OUT', -10, 90], ['SALE_RETURN_IN', 3, 93], ['ADJUSTMENT_OUT', -1, 92]])
    expect(reg[0]).toMatchObject({ is_opening: true, n: 0 })
    const sale = reg.find((r) => r.movement_type === 'SALE_OUT')
    const cust = (await q(`select name, licence_number from public.customers where id = $1`, [authorised]))[0]
    expect(sale).toMatchObject({ counterparty: cust.name, licence_number: cust.licence_number, reference: (await q(`select invoice_number from public.sales_invoices where id = $1`, [i]))[0].invoice_number })
    expect(sale.document_number).toMatch(/^SAL-/)
    expect(sale.batch_number).toBeTruthy()
    expect(reg.find((r) => r.movement_type === 'SALE_RETURN_IN')?.reference).toMatch(/^CRN-/)
    const sum = (await rows(call(pharmacist, `select opening::float8 o, received::float8 r, issued::float8 i, adjusted::float8 a, closing::float8 c from public.controlled_drug_summary($1, $2) where product_id = $3`, [day(0), day(0), C.id])))[0]
    expect(sum).toEqual({ o: 0, r: 103, i: 10, a: -1, c: 92 })
    // a later period starts from the closing balance, an earlier one is empty
    const later = await rows(call(pharmacist, `select is_opening, balance::float8 bal from public.controlled_drug_register($1, $2, $3)`, [C.id, day(1), day(2)]))
    expect(later).toEqual([{ is_opening: true, bal: 92 }])
    expect((await rows(call(pharmacist, `select balance::float8 b from public.controlled_drug_register($1, $2, $3)`, [C.id, day(-5), day(-2)])))).toEqual([{ b: 0 }])
    // only controlled medicines have a register
    const plain = await stocked({ price: 1, cost: 1 })
    expect((await failure(call(pharmacist, `select * from public.controlled_drug_register($1, $2, $3)`, [plain.id, day(0), day(0)]))).message).toMatch(/is not a controlled medicine/)
    expect((await rows(call(pharmacist, `select product_id from public.controlled_drug_summary($1, $2)`, [day(0), day(0)]))).map((r) => r.product_id)).not.toContain(plain.id)
  })

  it('is visible per branch to people holding registers.controlled, and to no-one else', async () => {
    const C = await stocked({ price: 50, cost: 20, qty: 20, cls: 'CONTROLLED' })
    const one = (user: string, product = C.id) => call(user, `select count(*)::int n, max(balance)::float8 bal from public.controlled_drug_register($1, $2, $3)`, [product, day(0), day(0)])
    expect((await rows(one(pharmacist)))[0]).toEqual({ n: 2, bal: 20 })                                  // opening line + the opening-stock movement
    expect((await rows(one(owner)))[0].n).toBe(2)
    expect((await rows(one(pharmacist2)))[0]).toEqual({ n: 1, bal: 0 })                                  // a branch-2 pharmacist sees none of branch 1's movements
    expect((await failure(one(rep))).code).toBe('42501')
    expect((await failure(one(accountsMgr))).code).toBe('42501')
    expect((await failure(one(b.ownerId))).code).toBe('P0002')
    expect((await rows(call(pharmacist2, `select opening::float8 o, closing::float8 c from public.controlled_drug_summary($1, $2) where product_id = $3`, [day(0), day(0), C.id])))[0]).toEqual({ o: 0, c: 0 })
    // stock at branch 2's warehouse is visible to branch 2's pharmacist
    const C2 = await stocked({ price: 50, cost: 20, qty: 7, cls: 'CONTROLLED', warehouse: wh2 })
    expect((await rows(one(pharmacist2, C2.id)))[0]).toEqual({ n: 2, bal: 7 })
    expect((await rows(one(pharmacist, C2.id)))[0]).toEqual({ n: 2, bal: 7 })                            // a pharmacist with organization-wide scope sees both
    expect((await failure(call(pharmacist, `select * from public.controlled_drug_register($1, $2, $1)`, [C.id, day(0)]))).code).toBeDefined()
  })
})

describe('payment reminders', () => {
  async function overdueInvoice(customer: string, product: string, daysLate: number, qty = 10): Promise<string> {
    const id = await invoice(customer, [{ product, qty }])
    const client = await admin.connect()
    try {
      await client.query('begin')
      await client.query('set local session_replication_role = replica')
      await client.query(`update public.sales_invoices set due_date = current_date - $2::int where id = $1`, [id, daysLate])
      await client.query('commit')
    } finally { client.release() }
    return id
  }
  const overdue = (user: string) => call(user, `select customer_id, overdue_amount::float8 amt, invoices, oldest_days, last_level, suggested_level from public.overdue_customers()`)

  it('lists customers with overdue unpaid invoices, records reminders with the invoices they cover, and suggests the next level only after a week', async () => {
    const P = await stocked({ price: 10, cost: 5 })
    const c = await addCustomer(); const fine = await addCustomer()
    const i1 = await overdueInvoice(c, P.id, 40, 10)                                                    // 100, 40 days late
    const i2 = await overdueInvoice(c, P.id, 5, 5)                                                      // 50, 5 days late
    await invoice(fine, [{ product: P.id, qty: 3 }])                                                    // not due yet
    const first = (await rows(overdue(accountsMgr))).find((r) => r.customer_id === c)
    expect(first).toEqual({ customer_id: c, amt: 150, invoices: 2, oldest_days: 40, last_level: null, suggested_level: 1 })
    expect((await rows(overdue(accountsMgr))).find((r) => r.customer_id === fine)).toBeUndefined()
    expect((await rows(call(owner, `select customer_id from public.overdue_customers(30)`))).map((r) => r.customer_id)).toContain(c)
    expect((await rows(call(owner, `select customer_id from public.overdue_customers(60)`))).map((r) => r.customer_id)).not.toContain(c)

    expect((await failure(call(rep, `select public.record_payment_reminder($1, 1, 'SMS', 'Please pay', $2::uuid[])`, [c, [i1]]))).code).toBe('42501')    // reps can look, not send
    const id = (await rows(call(accountsMgr, `select public.record_payment_reminder($1, 1, 'sms', 'Dear customer, GHS 150 is overdue', $2::uuid[]) as id`, [c, [i1, i2]])))[0].id
    const saved = (await q(`select level, channel, message, overdue_amount::float8 amt, cardinality(invoice_ids) n from public.payment_reminders where id = $1`, [id]))[0]
    expect(saved).toEqual({ level: 1, channel: 'SMS', message: 'Dear customer, GHS 150 is overdue', amt: 150, n: 2 })
    const after = (await rows(overdue(accountsMgr))).find((r) => r.customer_id === c)
    expect([after.last_level, after.suggested_level]).toEqual([1, null])                                // reminded just now: wait before the next
    const client = await admin.connect()
    try { await client.query('begin'); await client.query('set local session_replication_role = replica'); await client.query(`update public.payment_reminders set sent_at = now() - interval '8 days' where id = $1`, [id]); await client.query('commit') } finally { client.release() }
    expect((await rows(overdue(accountsMgr))).find((r) => r.customer_id === c)).toMatchObject({ last_level: 1, suggested_level: 2 })
    // append-only and unreachable
    for (const sql of [`update public.payment_reminders set message = 'x' where id = $1`, `delete from public.payment_reminders where id = $1`]) await expect(admin.query(sql, [id])).rejects.toBeTruthy()
    for (const user of [owner, accountsMgr]) {
      expect((await failure(call(user, `delete from public.payment_reminders`))).code).toBe('42501')
      expect((await failure(call(user, `insert into public.payment_reminders (customer_id, level, channel, message, invoice_ids, overdue_amount) values ($1, 1, 'SMS', 'x', array[$2::uuid], 1)`, [c, i1]))).code).toBe('42501')
    }
  })

  it('refuses reminders for invoices that are not overdue, not this customer’s, already paid, or with bad details; sees only what the role allows', async () => {
    const P = await stocked({ price: 10, cost: 5 })
    const c = await addCustomer(); const other = await addCustomer()
    const late = await overdueInvoice(c, P.id, 10)
    const foreign = await overdueInvoice(other, P.id, 10)
    const notDue = await invoice(c, [{ product: P.id, qty: 1 }])
    const bad = (customer: string, level: number, channel: string, message: string, ids: string[]) =>
      failure(call(accountsMgr, `select public.record_payment_reminder($1, $2, $3, $4, $5::uuid[])`, [customer, level, channel, message, ids]))
    expect((await bad(c, 1, 'SMS', 'x', [foreign])).message).toMatch(/every invoice must be an overdue, unpaid invoice of this customer/)
    expect((await bad(c, 1, 'SMS', 'x', [late, notDue])).message).toMatch(/every invoice must be an overdue/)
    expect((await bad(c, 4, 'SMS', 'x', [late])).code).toBe('22023')
    expect((await bad(c, 1, 'TELEPATHY', 'x', [late])).code).toBe('22023')
    expect((await bad(c, 1, 'SMS', '  ', [late])).code).toBe('22023')
    expect((await bad(c, 1, 'SMS', 'x', [])).code).toBe('22023')
    expect((await bad('00000000-0000-0000-0000-000000000000', 1, 'SMS', 'x', [late])).code).toBe('P0002')
    expect((await failure(call(b.ownerId, `select public.record_payment_reminder($1, 1, 'SMS', 'x', $2::uuid[])`, [c, [late]]))).code).toBe('P0002')
    // once paid it is no longer overdue
    await ok(call(owner, `select public.record_receipt($1, $2, 100, 'CASH', null, null, null)`, [c, a.hq]))
    expect((await bad(c, 1, 'SMS', 'x', [late])).message).toMatch(/every invoice must be an overdue/)
    expect((await rows(overdue(accountsMgr))).find((r) => r.customer_id === c)).toBeUndefined()
    // a branch-2 officer sees no branch-1 debts, and the walk-in customer is never chased
    expect((await rows(overdue(officer2))).find((r) => r.customer_id === other)).toBeUndefined()
    expect((await rows(overdue(b.ownerId)))).toEqual([])
    const walkIn = (await q(`select id from public.customers where organization_id = $1 and is_walk_in`, [a.id]))[0].id
    expect((await rows(overdue(owner))).find((r) => r.customer_id === walkIn)).toBeUndefined()
    const seen = (user: string) => withUser(user, async (cx) => (await cx.q(`select count(*)::int n from public.payment_reminders`)).rows[0].n)
    expect(await seen(pharmacist)).toBe(0)                                                              // no reminders.view
    expect(await seen(b.ownerId)).toBe(0)
  })
})
