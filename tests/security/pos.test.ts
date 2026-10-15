import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBranch, addProduct, addProductUnit, addUser, addWarehouse, admin, closePool, createOrg, rand, withUser, type Org } from '../helpers/db'

let a: Org
let b: Org
let wh: string
let branch2: string
let wh2: string
let owner: string
let cashier: string
let cashier2: string
let mgr: string          // BRANCH_MANAGER: pos.sell + view + manage
let rep: string          // SALES_REP: no pos rights
let auditor: string      // pos.view only
let defaultList: string
let walkIn: string

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  a = await createOrg('POS-A')
  b = await createOrg('POS-B')
  wh = await addWarehouse(a.id, a.hq, 'W1')
  branch2 = await addBranch(a.id, 'B2')
  wh2 = await addWarehouse(a.id, branch2, 'W2')
  owner = a.ownerId
  cashier = await addUser(a.id, 'CASHIER')
  cashier2 = await addUser(a.id, 'CASHIER')
  mgr = await addUser(a.id, 'BRANCH_MANAGER')
  rep = await addUser(a.id, 'SALES_REP')
  auditor = await addUser(a.id, 'AUDITOR')
  defaultList = (await q(`insert into public.price_lists (organization_id, code, name, is_default) values ($1, 'RETAIL', 'Retail', true) returning id`, [a.id]))[0].id
  walkIn = (await q(`select id from public.customers where organization_id = $1 and is_walk_in`, [a.id]))[0].id
})
afterAll(closePool)

type Out = { ok: true; rows: any[] } | { ok: false; code: string; message: string }
const call = (user: string, sql: string, params: unknown[] = []): Promise<Out> => withUser(user, (c) => c.attempt(sql, params), { commit: true }) as Promise<Out>
const ok = async (p: Promise<Out>) => {
  const r = await p
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`)
  return r.rows[0]
}
const failure = async (p: Promise<Out>) => { const r = await p; return r.ok ? { code: 'ok', message: '' } : { code: r.code, message: r.message } }
const code = async (p: Promise<Out>) => (await failure(p)).code
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows
const num = (v: unknown) => Number(v)

async function sellable(qty = 1000, o: { price?: number; cls?: string } = {}) {
  const product = await addProduct(a.id, { cls: o.cls ?? 'GSL' })
  const box = await addProductUnit(a.id, product.id, 'BOX', 10)
  for (const [unit, price] of [[product.baseUnitRowId, o.price ?? 2], [box, (o.price ?? 2) * 10]] as const) {
    await q(`insert into public.price_list_items (organization_id, price_list_id, product_id, product_unit_id, unit_price) values ($1, $2, $3, $4, $5)`, [a.id, defaultList, product.id, unit, price])
  }
  await ok(call(owner, `select public.post_stock_document('OPENING', $1, $2::jsonb) as r`, [wh, JSON.stringify([{ product_id: product.id, quantity: qty, batch_number: `B${rand()}`, expiry_date: day(300) }])]))
  return { product, box }
}
const onHand = async (productId: string) => num((await q(`select coalesce(sum(quantity),0) n from public.stock_balances where product_id = $1 and stock_status = 'AVAILABLE'`, [productId]))[0].n)

const open = async (user = cashier, float = 100, warehouse = wh) => (await ok(call(user, `select public.open_pos_session($1, $2) as id`, [warehouse, float]))).id as string
const closeSession = (user: string, id: string, counted: number, notes: string | null = null) => call(user, `select public.close_pos_session($1, $2, $3) as r`, [id, counted, notes])
const checkout = (user: string, session: string, lines: object[], payments: object[], customer: string | null = null, reason: string | null = null) =>
  call(user, `select public.pos_checkout($1, $2, $3::jsonb, $4::jsonb, $5) as r`, [session, customer, JSON.stringify(lines), JSON.stringify(payments), reason])
const summary = async (user: string, id: string) => (await ok(call(user, `select public.pos_session_summary($1) as r`, [id]))).r
const cash = (amount: number) => ({ method: 'CASH', amount })
const momo = (amount: number, reference = 'MM123') => ({ method: 'MOBILE_MONEY', amount, reference })

async function addCustomer(o: { limit?: number; type?: string; licence?: boolean } = {}): Promise<string> {
  return (await q(
    `insert into public.customers (organization_id, code, name, customer_type, licence_number, licence_expiry, payment_terms_days, credit_limit)
     values ($1, $2, $3, $4, $5, $6, 30, $7) returning id`,
    [a.id, `C${rand()}`, `Customer ${rand()}`, o.type ?? 'PHARMACY', o.licence === false ? null : 'PC/1', o.licence === false ? null : day(300), o.limit ?? 5000]))[0].id
}

describe('the walk-in customer', () => {
  it('exists in every organization (new and existing), cash-only, unlicensed, and only one per organization', async () => {
    for (const org of [a, b]) {
      const rows = await q(`select code, name, customer_type, credit_limit::float8 cl, payment_terms_days, licence_number from public.customers where organization_id = $1 and is_walk_in`, [org.id])
      expect(rows).toEqual([{ code: 'WALKIN', name: 'Walk-in customer', customer_type: 'RETAILER', cl: 0, payment_terms_days: 0, licence_number: null }])
    }
    await expect(admin.query(`insert into public.customers (organization_id, code, name, is_walk_in) values ($1, 'WALK2', 'Second walk-in', true)`, [a.id])).rejects.toMatchObject({ code: '23505' })
  })

  it('cannot be made into a credit or licensed customer, deactivated, deleted, created or flagged by users', async () => {
    for (const sql of [
      `update public.customers set credit_limit = 100 where id = $1`, `update public.customers set is_active = false where id = $1`,
      `update public.customers set customer_type = 'PHARMACY' where id = $1`, `update public.customers set payment_terms_days = 30 where id = $1`,
      `update public.customers set licence_number = 'X', licence_expiry = current_date + 90 where id = $1`, `update public.customers set controlled_drugs_authorised = true where id = $1`,
      `update public.customers set is_walk_in = false where id = $1`, `delete from public.customers where id = $1`,
    ]) await expect(admin.query(sql, [walkIn]), sql).rejects.toMatchObject({ code: '42501' })
    const c = await addCustomer()
    await expect(admin.query(`update public.customers set is_walk_in = true where id = $1`, [c])).rejects.toBeTruthy()
    expect(await code(call(owner, `insert into public.customers (code, name, is_walk_in) values ('FAKE', 'Fake walk-in', true)`))).toBe('42501')
    expect(await code(call(owner, `update public.customers set contact_name = 'Till 1', phone = '024' where id = $1`, [walkIn]))).toBe('ok')   // contact details may change
  })
})

describe('till sessions', () => {
  it('lets cashiers open one session at a time at a warehouse of their branch, numbered, with a float', async () => {
    const c1 = await addUser(a.id, 'CASHIER')
    const id = await open(c1, 150)
    const row = (await q(`select * from public.pos_sessions where id = $1`, [id]))[0]
    expect(row).toMatchObject({ status: 'OPEN', cashier_id: c1, branch_id: a.hq, warehouse_id: wh, opening_float: '150.00' })
    expect(row.session_number).toMatch(/^SHF-\d{4}-\d{6}$/)
    expect((await failure(call(c1, `select public.open_pos_session($1, 0)`, [wh]))).message).toMatch(/already have an open till session/)
    expect(await code(call(await addUser(a.id, 'CASHIER', a.hq), `select public.open_pos_session($1, 0)`, [wh2]))).toBe('42501')   // a cashier of the head office cannot open a till at branch 2
    expect(await code(call(await addUser(a.id, 'CASHIER'), `select public.open_pos_session($1, -1)`, [wh]))).toBe('22023')
    expect(await code(call(await addUser(a.id, 'CASHIER'), `select public.open_pos_session($1, 1.005)`, [wh]))).toBe('22023')
    expect(await code(call(rep, `select public.open_pos_session($1, 0)`, [wh]))).toBe('42501')                  // no pos.sell
    expect(await code(call(auditor, `select public.open_pos_session($1, 0)`, [wh]))).toBe('42501')
    expect(await code(call(b.ownerId, `select public.open_pos_session($1, 0)`, [wh]))).toBe('P0002')            // another organization's warehouse
    await ok(closeSession(c1, id, 150))
    expect(await code(call(c1, `select public.open_pos_session($1, 0)`, [wh]))).toBe('ok')                       // after closing, a new one opens
  })

  it('is visible to its cashier and to pos.view at the branch, nobody else', async () => {
    const c1 = await addUser(a.id, 'CASHIER')
    const id = await open(c1)
    const count = (user: string) => withUser(user, async (c) => (await c.q(`select count(*)::int n from public.pos_sessions where id = $1`, [id])).rows[0].n)
    expect([await count(c1), await count(mgr), await count(auditor), await count(owner)]).toEqual([1, 1, 1, 1])
    expect([await count(cashier2), await count(rep), await count(b.ownerId)]).toEqual([0, 0, 0])
    expect((await failure(call(cashier2, `select public.pos_session_summary($1)`, [id]))).code).toBe('P0002')
    expect(await code(call(auditor, `select public.pos_session_summary($1)`, [id]))).toBe('ok')
    for (const user of [owner, c1]) {
      expect(await code(call(user, `update public.pos_sessions set opening_float = 999999 where id = $1`, [id]))).toBe('42501')
      expect(await code(call(user, `delete from public.pos_sessions where id = $1`, [id]))).toBe('42501')
    }
    await ok(closeSession(c1, id, 0, 'test'))
  })
})

describe('counter sales', () => {
  it('sells for cash with change: invoice posted, stock out, one receipt for what was kept, session and walk-in tallied', async () => {
    const s = await sellable(1000, { price: 2 })
    const id = await open(cashier, 100)
    const r = (await ok(checkout(cashier, id, [{ product_id: s.product.id, quantity: 12 }, { product_id: s.product.id, product_unit_id: s.box, quantity: 2 }], [cash(100)]))).r
    expect([num(r.total_amount), num(r.paid), num(r.owed), num(r.cash_tendered), num(r.change)]).toEqual([64, 64, 0, 100, 36])   // 12x2 + 2 boxes x 20
    expect(r.invoice_number).toMatch(/^INV-\d{4}-\d{6}$/)
    expect(await onHand(s.product.id)).toBe(1000 - 12 - 20)
    const inv = (await q(`select * from public.sales_invoices where id = $1`, [r.invoice_id]))[0]
    expect(inv).toMatchObject({ status: 'POSTED', customer_id: walkIn, total_amount: '64.00', amount_paid: '64.00', balance_due: '0.00', branch_id: a.hq, warehouse_id: wh })
    expect(inv.customer_reference).toMatch(/^POS SHF-/)
    const pays = await q(`select r.method, r.amount::float8 amount, r.status from public.pos_sale_payments p join public.customer_receipts r on r.id = p.receipt_id where p.pos_session_id = $1`, [id])
    expect(pays).toEqual([{ method: 'CASH', amount: 64, status: 'POSTED' }])                                             // the change is not a payment
    expect((await q(`select cash_tendered::float8 t, change_given::float8 c, customer_id from public.pos_sales where id = $1`, [r.pos_sale_id]))[0]).toEqual({ t: 100, c: 36, customer_id: walkIn })
    const sum = await summary(cashier, id)
    expect([sum.sales_count, num(sum.sales_total), num(sum.cash_in), num(sum.expected_cash)]).toEqual([1, 64, 64, 164])
    await ok(closeSession(cashier, id, 164))
  })

  it('takes split payments (cash + mobile money), keeps cash exact and non-cash exact, and records every receipt', async () => {
    const s = await sellable(1000, { price: 5 })
    const id = await open(cashier2, 0)
    const r = (await ok(checkout(cashier2, id, [{ product_id: s.product.id, quantity: 20 }], [momo(60, 'MTN-778'), cash(50)]))).r        // total 100: 60 momo, 40 cash of 50
    expect([num(r.total_amount), num(r.paid), num(r.change)]).toEqual([100, 100, 10])
    const sum = await summary(cashier2, id)
    expect(sum.by_method).toEqual([{ method: 'CASH', payments: 1, amount: 40 }, { method: 'MOBILE_MONEY', payments: 1, amount: 60 }])
    expect(num(sum.expected_cash)).toBe(40)
    await ok(closeSession(cashier2, id, 40))
  })

  it('refuses unpaid, overpaid-by-card and reference-less payments for the walk-in customer, leaving nothing behind', async () => {
    const s = await sellable(100, { price: 10 })
    const id = await open(await addUser(a.id, 'CASHIER'), 0)
    const user = (await q(`select cashier_id from public.pos_sessions where id = $1`, [id]))[0].cashier_id
    const before = async () => [num((await q(`select count(*)::int n from public.sales_invoices where organization_id = $1`, [a.id]))[0].n),
      num((await q(`select count(*)::int n from public.customer_receipts where organization_id = $1`, [a.id]))[0].n), await onHand(s.product.id)]
    const snapshot = await before()
    const line = [{ product_id: s.product.id, quantity: 5 }]                                                          // total 50
    expect((await failure(checkout(user, id, line, [cash(20)]))).message).toMatch(/credit check failed/)               // short: the walk-in has no credit
    expect((await failure(checkout(user, id, line, []))).message).toMatch(/credit check failed/)
    expect((await failure(checkout(user, id, line, [momo(60)]))).message).toMatch(/more than the total/)
    expect((await failure(checkout(user, id, line, [{ method: 'CARD', amount: 50 }]))).message).toMatch(/needs its reference/)
    expect((await failure(checkout(user, id, line, [{ method: 'BARTER', amount: 50 }]))).code).toBe('22023')
    expect((await failure(checkout(user, id, line, [cash(0)]))).code).toBe('22023')
    expect((await failure(checkout(user, id, line, [cash(50.005)]))).code).toBe('22023')
    expect((await failure(checkout(user, id, line, Array(6).fill(cash(1))))).code).toBe('22023')
    expect((await failure(checkout(user, id, [{ product_id: s.product.id, quantity: 500 }], [cash(5000)]))).message).toMatch(/not enough sellable stock/)
    expect(await before()).toEqual(snapshot)                                                                           // no draft invoice, receipt or stock change survived
  })

  it('applies the regulatory rule: the walk-in customer cannot buy prescription-only, pharmacy-only or controlled medicines, a licensed pharmacy can', async () => {
    const pom = await sellable(100, { price: 10, cls: 'POM' })
    const id = await open(await addUser(a.id, 'CASHIER'), 0)
    const user = (await q(`select cashier_id from public.pos_sessions where id = $1`, [id]))[0].cashier_id
    const refused = await failure(checkout(user, id, [{ product_id: pom.product.id, quantity: 1 }], [cash(10)]))
    expect(refused.code).toBe('22023')
    expect(refused.message).toMatch(/is a medicine .* not a licensed pharmacy/)
    expect(await onHand(pom.product.id)).toBe(100)
    const pharmacy = await addCustomer()
    await ok(checkout(user, id, [{ product_id: pom.product.id, quantity: 1 }], [cash(10)], pharmacy))
    expect(await onHand(pom.product.id)).toBe(99)
  })

  it('sells on account to a customer with credit (no payment), but not past their limit without the right to override', async () => {
    const s = await sellable(1000, { price: 10 })
    const id = await open(cashier, 0)
    const credit = await addCustomer({ limit: 300 })
    const r = (await ok(checkout(cashier, id, [{ product_id: s.product.id, quantity: 20 }], [], credit))).r              // 200 owed
    expect([num(r.paid), num(r.owed)]).toEqual([0, 200])
    expect((await failure(checkout(cashier, id, [{ product_id: s.product.id, quantity: 20 }], [cash(50)], credit))).message).toMatch(/credit check failed/)   // 150 more -> 350 > 300
    await ok(checkout(cashier, id, [{ product_id: s.product.id, quantity: 20 }], [cash(100)], credit))                  // 100 owed more -> 300
    const sum = await summary(cashier, id)
    expect([sum.sales_count, num(sum.sales_total)]).toEqual([2, 400])
    await ok(closeSession(cashier, id, 100))
  })

  it('enforces the cashier’s own rights: no discounts or other prices, only their own open session, only with pos.sell', async () => {
    const s = await sellable(1000, { price: 10 })
    const id = await open(cashier, 0)
    expect((await failure(checkout(cashier, id, [{ product_id: s.product.id, quantity: 1, discount_percent: 10 }], [cash(10)]))).code).toBe('42501')
    expect((await failure(checkout(cashier, id, [{ product_id: s.product.id, quantity: 1, unit_price: 1 }], [cash(10)]))).code).toBe('42501')
    expect((await failure(checkout(cashier2, id, [{ product_id: s.product.id, quantity: 1 }], [cash(10)]))).message).toMatch(/belongs to another cashier/)
    expect((await failure(checkout(mgr, id, [{ product_id: s.product.id, quantity: 1 }], [cash(10)]))).message).toMatch(/belongs to another cashier/)
    expect((await failure(checkout(rep, id, [{ product_id: s.product.id, quantity: 1 }], [cash(10)]))).code).toBe('42501')
    expect((await failure(checkout(cashier, '00000000-0000-0000-0000-000000000000', [{ product_id: s.product.id, quantity: 1 }], [cash(10)]))).code).toBe('P0002')
    expect((await failure(checkout(cashier, id, [], [cash(10)]))).code).toBe('22023')
    // a manager with discount rights can discount in their own session
    const mid = await open(mgr, 0)
    const r = (await ok(checkout(mgr, mid, [{ product_id: s.product.id, quantity: 10, discount_percent: 10 }], [cash(100)]))).r
    expect(num(r.total_amount)).toBe(90)
    await ok(closeSession(mgr, mid, 90))
    await ok(closeSession(cashier, id, 0))
  })

  it('cannot sell in a closed session, nor from other organizations’ sessions', async () => {
    const s = await sellable(100, { price: 1 })
    const id = await open(cashier, 0)
    await ok(closeSession(cashier, id, 0))
    expect((await failure(checkout(cashier, id, [{ product_id: s.product.id, quantity: 1 }], [cash(1)]))).message).toMatch(/session is closed/)
    expect((await failure(checkout(b.ownerId, id, [{ product_id: s.product.id, quantity: 1 }], [cash(1)]))).code).toBe('P0002')
  })
})

describe('closing a till session', () => {
  it('compares counted with expected cash (float + cash kept, voided payments excluded), records the variance, and needs a note for a difference', async () => {
    const s = await sellable(1000, { price: 1 })
    const c1 = await addUser(a.id, 'CASHIER')
    const id = await open(c1, 200)
    const r1 = (await ok(checkout(c1, id, [{ product_id: s.product.id, quantity: 30 }], [cash(30)]))).r
    await ok(checkout(c1, id, [{ product_id: s.product.id, quantity: 20 }], [momo(20)]))
    const r3 = (await ok(checkout(c1, id, [{ product_id: s.product.id, quantity: 50 }], [cash(60)]))).r                   // 10 change
    expect(num((await summary(c1, id)).expected_cash)).toBe(200 + 30 + 50)
    // a bounced / mistaken cash payment is voided: its cash no longer counts
    const rcp = (await q(`select receipt_id from public.pos_sale_payments where pos_sale_id = $1`, [r1.pos_sale_id]))[0].receipt_id
    await ok(call(owner, `select public.void_receipt($1, 'Counterfeit note')`, [rcp]))
    expect(num((await summary(c1, id)).expected_cash)).toBe(200 + 50)
    expect((await failure(closeSession(c1, id, 240))).message).toMatch(/holds 240 but 250(.00)? was expected: explain the difference/)
    expect((await failure(closeSession(c1, id, -5, 'x'))).code).toBe('22023')
    expect((await failure(closeSession(cashier2, id, 250))).code).toBe('42501')                                           // not their session
    expect((await failure(closeSession(rep, id, 250))).code).toBe('42501')
    const done = (await ok(closeSession(c1, id, 240, 'GHS 10 short - counted twice'))).r
    expect([num(done.expected_cash), num(done.counted_cash), num(done.variance), done.sales_count, num(done.sales_total)]).toEqual([250, 240, -10, 3, 100])
    expect(await q(`select status, variance::float8 v, close_notes, closed_by, sales_count from public.pos_sessions where id = $1`, [id])).toEqual([{ status: 'CLOSED', v: -10, close_notes: 'GHS 10 short - counted twice', closed_by: c1, sales_count: 3 }])
    expect((await q(`select count(*)::int n from public.audit_logs where entity_type = 'pos_session' and entity_id = $1`, [id]))[0].n).toBeGreaterThanOrEqual(2)
    expect((await failure(closeSession(c1, id, 250))).message).toMatch(/already closed/)
    expect(r3.change).toBeDefined()
  })

  it('does not let a voided counter payment (a debt of the walk-in customer) block later counter sales', async () => {
    const s = await sellable(100, { price: 1 })
    const c1 = await addUser(a.id, 'CASHIER')
    const id = await open(c1, 0)
    const r = (await ok(checkout(c1, id, [{ product_id: s.product.id, quantity: 30 }], [cash(30)]))).r
    await ok(call(owner, `select public.void_receipt($1, 'Counterfeit note')`, [(await q(`select receipt_id from public.pos_sale_payments where pos_sale_id = $1`, [r.pos_sale_id]))[0].receipt_id]))
    expect(num((await q(`select balance_due from public.sales_invoices where id = $1`, [r.invoice_id]))[0].balance_due)).toBe(30)   // the debt is recorded...
    await ok(checkout(c1, id, [{ product_id: s.product.id, quantity: 1 }], [cash(1)]))                                              // ...but the next sale still goes through
    expect((await failure(checkout(c1, id, [{ product_id: s.product.id, quantity: 1 }], [cash(0.5)]))).message).toMatch(/credit check failed/)   // while unpaid walk-in sales stay refused
    await ok(closeSession(c1, id, 1))
  })

  it('lets a manager close a cashier’s forgotten session, and a closed session can never be edited', async () => {
    const c1 = await addUser(a.id, 'CASHIER')
    const id = await open(c1, 50)
    expect((await failure(closeSession(cashier2, id, 50))).code).toBe('42501')
    expect(await code(closeSession(mgr, id, 50))).toBe('ok')
    expect((await q(`select closed_by from public.pos_sessions where id = $1`, [id]))[0].closed_by).toBe(mgr)
    for (const sql of [`update public.pos_sessions set counted_cash = 1 where id = $1`, `update public.pos_sessions set status = 'OPEN' where id = $1`, `delete from public.pos_sessions where id = $1`])
      await expect(admin.query(sql, [id]), sql).rejects.toBeTruthy()
    // the cashier can now open a new session
    expect(await code(call(c1, `select public.open_pos_session($1, 0)`, [wh]))).toBe('ok')
  })

  it('keeps sales and payments append-only and out of reach of users', async () => {
    const s = await sellable(100, { price: 1 })
    const c1 = await addUser(a.id, 'CASHIER')
    const id = await open(c1, 0)
    const r = (await ok(checkout(c1, id, [{ product_id: s.product.id, quantity: 5 }], [cash(5)]))).r
    for (const sql of [
      `update public.pos_sales set total_amount = 1 where id = $1`, `delete from public.pos_sales where id = $1`,
      `update public.pos_sale_payments set amount = 1 where pos_sale_id = $1`, `delete from public.pos_sale_payments where pos_sale_id = $1`,
    ]) await expect(admin.query(sql, [r.pos_sale_id]), sql).rejects.toBeTruthy()
    for (const table of ['pos_sales', 'pos_sale_payments', 'pos_sessions']) {
      expect(await code(call(owner, `delete from public.${table}`))).toBe('42501')
      expect(await code(call(owner, `insert into public.${table} (organization_id) values ($1)`, [a.id]))).toBe('42501')
    }
    const count = (user: string) => withUser(user, async (c) => (await c.q(`select count(*)::int n from public.pos_sales where id = $1`, [r.pos_sale_id])).rows[0].n)
    expect([await count(c1), await count(auditor), await count(mgr)]).toEqual([1, 1, 1])
    expect([await count(cashier2), await count(rep), await count(b.ownerId)]).toEqual([0, 0, 0])
    await ok(closeSession(c1, id, 5))
  })
})

describe('post_sales_invoice with several payments', () => {
  it('still takes a single payment object and now also a list; the payments are recorded and allocated to the invoice', async () => {
    const s = await sellable(1000, { price: 1 })
    const c = await addCustomer({ limit: 0 })
    const mk = async (n: number) => (await ok(call(owner, `select public.save_sales_invoice(null, $1, $2, null, null, $3::jsonb) as id`, [c, wh, JSON.stringify([{ product_id: s.product.id, quantity: n }])]))).id as string
    const one = await mk(10)
    const r1 = (await ok(call(owner, `select public.post_sales_invoice($1, null, $2::jsonb) as r`, [one, JSON.stringify({ amount: 10, method: 'CASH' })]))).r
    expect([r1.receipt_numbers.length, r1.receipt_number]).toEqual([1, r1.receipt_numbers[0]])
    const two = await mk(100)
    const r2 = (await ok(call(owner, `select public.post_sales_invoice($1, null, $2::jsonb) as r`, [two, JSON.stringify([{ amount: 30, method: 'CASH' }, { amount: 70, method: 'CARD', reference: 'AUTH-1' }])]))).r
    expect(r2.receipt_numbers).toHaveLength(2)
    expect((await q(`select amount_paid::float8 p, balance_due::float8 d from public.sales_invoices where id = $1`, [two]))[0]).toEqual({ p: 100, d: 0 })
    const three = await mk(10)
    expect((await failure(call(owner, `select public.post_sales_invoice($1, null, $2::jsonb)`, [three, JSON.stringify([{ amount: 6, method: 'CASH' }, { amount: 6, method: 'CASH' }])]))).message).toMatch(/more than the invoice total/)
    expect((await failure(call(owner, `select public.post_sales_invoice($1, null, $2::jsonb)`, [three, JSON.stringify(Array(6).fill({ amount: 1, method: 'CASH' }))]))).message).toMatch(/at most 5 payments/)
    expect((await failure(call(owner, `select public.post_sales_invoice($1, null, $2::jsonb)`, [three, JSON.stringify([{ amount: 5, method: 'CASH' }])]))).message).toMatch(/credit check failed/)   // limit 0: must be paid in full
  })
})
