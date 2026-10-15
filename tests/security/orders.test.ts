import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBranch, addProduct, addProductUnit, addUser, addWarehouse, admin, closePool, createOrg, rand, withUser, type Org } from '../helpers/db'

let a: Org
let b: Org
let wh: string
let branch2: string
let owner: string
let salesMgr: string   // quotations + orders (all), sales create/post
let rep: string        // quotations.create, orders.create, sales.create (no confirm, no post, no price override)
let cashier: string    // view only + pos
let accounts: string   // orders.view
let rep2: string       // branch 2 only
let defaultList: string

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  a = await createOrg('ORD-A')
  b = await createOrg('ORD-B')
  wh = await addWarehouse(a.id, a.hq, 'W1')
  branch2 = await addBranch(a.id, 'B2')
  await addWarehouse(a.id, branch2, 'W2')
  owner = a.ownerId
  salesMgr = await addUser(a.id, 'SALES_MANAGER')
  rep = await addUser(a.id, 'SALES_REP')
  cashier = await addUser(a.id, 'CASHIER')
  accounts = await addUser(a.id, 'ACCOUNTS_MANAGER')
  rep2 = await addUser(a.id, 'SALES_REP', branch2)
  defaultList = (await q(`insert into public.price_lists (organization_id, code, name, is_default) values ($1, 'RETAIL', 'Retail', true) returning id`, [a.id]))[0].id
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

async function addCustomer(o: { limit?: number } = {}): Promise<string> {
  return (await q(
    `insert into public.customers (organization_id, code, name, customer_type, licence_number, licence_expiry, payment_terms_days, credit_limit)
     values ($1, $2, $3, 'PHARMACY', 'PC/1', $4, 30, $5) returning id`, [a.id, `C${rand()}`, `Customer ${rand()}`, day(300), o.limit ?? 100000]))[0].id
}
async function sellable(qty = 1000, price = 2) {
  const product = await addProduct(a.id, { cls: 'GSL' })
  const box = await addProductUnit(a.id, product.id, 'BOX', 10)
  const items: Record<string, string> = {}
  for (const [unit, p] of [[product.baseUnitRowId, price], [box, price * 10]] as const) {
    items[unit] = (await q(`insert into public.price_list_items (organization_id, price_list_id, product_id, product_unit_id, unit_price) values ($1, $2, $3, $4, $5) returning id`, [a.id, defaultList, product.id, unit, p]))[0].id
  }
  await ok(call(owner, `select public.post_stock_document('OPENING', $1, $2::jsonb) as r`, [wh, JSON.stringify([{ product_id: product.id, quantity: qty, batch_number: `B${rand()}`, expiry_date: day(300) }])]))
  return { product, box, items }
}
const avail = async (user: string, productId: string, warehouse = wh) => (await ok(call(user, `select on_hand::float8 on_hand, reserved::float8 reserved, free::float8 free from public.stock_availability($1, $2)`, [warehouse, productId])))
const saveOrder = (user: string, o: { id?: string | null; customer: string; lines: object[]; wh?: string; required?: string | null; until?: string | null; ref?: string | null }) =>
  call(user, `select public.save_sales_order($1, $2, $3, $4, $5, $6, null, $7::jsonb) as id`, [o.id ?? null, o.customer, o.wh ?? wh, o.required ?? null, o.until ?? null, o.ref ?? null, JSON.stringify(o.lines)])
const order = async (customer: string, lines: object[], user = salesMgr, until: string | null = null) => (await ok(saveOrder(user, { customer, lines, until }))).id as string
const confirm = (user: string, id: string) => call(user, `select public.confirm_sales_order($1) as r`, [id])
const confirmed = async (customer: string, lines: object[], until: string | null = null) => { const id = await order(customer, lines, salesMgr, until); await ok(confirm(salesMgr, id)); return id }
const ord = async (id: string) => (await q(`select * from public.sales_orders where id = $1`, [id]))[0]
const progress = async (id: string) => (await ok(call(salesMgr, `select jsonb_agg(jsonb_build_object('q', quantity::float8, 'inv', invoiced::float8, 'draft', in_draft::float8, 'rem', remaining::float8, 'res', reserved_base::float8) order by line_no) as p from public.order_progress($1)`, [id]))).p
const invoiceOrder = (user: string, id: string, lines: object[] | null = null) => call(user, `select public.invoice_sales_order($1, $2::jsonb) as id`, [id, lines ? JSON.stringify(lines) : null])
const postInvoice = (user: string, id: string, payment: object | null = null) => call(user, `select public.post_sales_invoice($1, null, $2::jsonb) as r`, [id, payment ? JSON.stringify(payment) : null])
const inv = async (id: string) => (await q(`select * from public.sales_invoices where id = $1`, [id]))[0]
const qline = (productId: string, quantity: number, extra: object = {}) => ({ product_id: productId, quantity, ...extra })

describe('quotations', () => {
  it('prices from the customer’s list with tax, numbers on sending, then freezes; the customer can accept it into an order at the quoted prices', async () => {
    const s = await sellable(1000, 2)
    const tax = (await q(`insert into public.tax_codes (organization_id, code, name, rate) values ($1, $2, 'VAT', 10) returning id`, [a.id, `V${rand()}`]))[0].id
    await q(`update public.products set tax_code_id = $2 where id = $1`, [s.product.id, tax])
    const c = await addCustomer()
    const id = (await ok(call(rep, `select public.save_quotation(null, $1, $2, $3, 'RFQ-9', null, $4::jsonb) as id`, [c, wh, day(10), JSON.stringify([qline(s.product.id, 100)])]))).id
    const row = (await q(`select * from public.sales_quotations where id = $1`, [id]))[0]
    expect(row).toMatchObject({ status: 'DRAFT', quotation_number: null, customer_id: c, branch_id: a.hq, subtotal: '200.00', tax_total: '20.00', total_amount: '220.00', customer_reference: 'RFQ-9' })
    const no = (await ok(call(rep, `select public.send_quotation($1) as n`, [id]))).n
    expect(no).toMatch(/^QUO-\d{4}-\d{6}$/)
    expect((await q(`select status from public.sales_quotations where id = $1`, [id]))[0].status).toBe('SENT')
    for (const sql of [`update public.sales_quotations set total_amount = 1, subtotal = 1, tax_total = 0 where id = $1`, `update public.sales_quotations set valid_until = valid_until + 30 where id = $1`,
                       `update public.sales_quotation_lines set quantity = 1 where quotation_id = $1`, `delete from public.sales_quotation_lines where quotation_id = $1`, `delete from public.sales_quotations where id = $1`])
      await expect(admin.query(sql, [id]), sql).rejects.toBeTruthy()
    expect((await failure(call(rep, `select public.save_quotation($1, $2, $3, $4, null, null, $5::jsonb)`, [id, c, wh, day(10), JSON.stringify([qline(s.product.id, 1)])]))).message).toMatch(/only a draft quotation can be edited/)
    // the list price rises after the quotation: the order keeps the quoted price
    await q(`update public.price_list_items set unit_price = 3 where id = $1`, [s.items[s.product.baseUnitRowId]])
    const orderId = (await ok(call(rep, `select public.convert_quotation_to_order($1) as id`, [id]))).id
    expect(await ord(orderId)).toMatchObject({ status: 'DRAFT', customer_id: c, quotation_id: id, total_amount: '220.00', subtotal: '200.00' })
    expect((await q(`select unit_price::float8 p, tax_rate::float8 t from public.sales_order_lines where sales_order_id = $1`, [orderId]))[0]).toEqual({ p: 2, t: 10 })
    expect((await q(`select status, converted_order_id from public.sales_quotations where id = $1`, [id]))[0]).toEqual({ status: 'ACCEPTED', converted_order_id: orderId })
    expect((await failure(call(rep, `select public.convert_quotation_to_order($1)`, [id]))).message).toMatch(/only a sent quotation can be accepted/)
    expect((await failure(call(rep, `select public.cancel_quotation($1, 'x')`, [id]))).message).toMatch(/accepted quotation cannot be cancelled/)
  })

  it('refuses expired validity, unknown reasons, wrong states and the wrong people', async () => {
    const s = await sellable()
    const c = await addCustomer()
    const lines = JSON.stringify([qline(s.product.id, 5)])
    expect((await failure(call(rep, `select public.save_quotation(null, $1, $2, $3, null, null, $4::jsonb)`, [c, wh, day(-1), lines]))).code).toBe('22023')
    expect((await failure(call(cashier, `select public.save_quotation(null, $1, $2, $3, null, null, $4::jsonb)`, [c, wh, day(5), lines]))).code).toBe('42501')
    expect((await failure(call(rep2, `select public.save_quotation(null, $1, $2, $3, null, null, $4::jsonb)`, [c, wh, day(5), lines]))).code).toBe('42501')   // branch 2 rep, branch 1 warehouse
    expect((await failure(call(b.ownerId, `select public.save_quotation(null, $1, $2, $3, null, null, $4::jsonb)`, [c, wh, day(5), lines]))).code).toBe('P0002')
    expect((await failure(call(rep, `select public.save_quotation(null, $1, $2, $3, null, null, '[]'::jsonb)`, [c, wh, day(5)]))).code).toBe('22023')
    const id = (await ok(call(rep, `select public.save_quotation(null, $1, $2, $3, null, null, $4::jsonb) as id`, [c, wh, day(5), lines]))).id
    expect((await failure(call(rep, `select public.reject_quotation($1, 'no')`, [id]))).message).toMatch(/draft quotation cannot be rejected/)   // only a sent one can be rejected
    expect((await failure(call(rep, `select public.convert_quotation_to_order($1)`, [id]))).message).toMatch(/only a sent quotation/)
    await ok(call(rep, `select public.send_quotation($1)`, [id]))
    const visible = (user: string) => withUser(user, async (cx) => (await cx.q(`select count(*)::int n from public.sales_quotations where id = $1`, [id])).rows[0].n)
    expect([await visible(rep), await visible(cashier), await visible(accounts), await visible(rep2), await visible(b.ownerId)]).toEqual([1, 1, 1, 0, 0])
    // time passes: it expires and can no longer be accepted
    const client = await admin.connect()
    try { await client.query('begin'); await client.query('set local session_replication_role = replica'); await client.query(`update public.sales_quotations set valid_until = current_date - 1 where id = $1`, [id]); await client.query('commit') } finally { client.release() }
    expect((await failure(call(rep, `select public.convert_quotation_to_order($1)`, [id]))).message).toMatch(/expired on/)
    expect((await failure(call(rep, `select public.reject_quotation($1, '')`, [id]))).code).toBe('22023')
    await ok(call(rep, `select public.reject_quotation($1, 'Went with a competitor')`, [id]))
    expect((await q(`select status, status_reason from public.sales_quotations where id = $1`, [id]))[0]).toEqual({ status: 'REJECTED', status_reason: 'Went with a competitor' })
    expect((await failure(call(rep, `select public.cancel_quotation($1, 'x')`, [id]))).message).toMatch(/rejected quotation cannot be cancelled/)
    // a draft can be cancelled, and an expired draft cannot be sent
    const d = (await ok(call(rep, `select public.save_quotation(null, $1, $2, $3, null, null, $4::jsonb) as id`, [c, wh, day(5), lines]))).id
    await ok(call(rep, `select public.cancel_quotation($1, 'Duplicate')`, [d]))
    expect((await failure(call(rep, `select public.send_quotation($1)`, [d]))).message).toMatch(/only a draft quotation can be sent/)
  })
})

describe('sales orders and reservations', () => {
  it('drafts an order, confirms it (numbered), and reserves its stock; only people with orders.confirm may confirm', async () => {
    const s = await sellable(1000, 2)
    const c = await addCustomer()
    expect((await failure(saveOrder(owner, { customer: (await q(`select id from public.customers where organization_id = $1 and is_walk_in`, [a.id]))[0].id, lines: [qline(s.product.id, 1)] }))).message).toMatch(/orders are for named customers/)
    const id = await order(c, [qline(s.product.id, 300), qline(s.product.id, 10, { product_unit_id: s.box })], rep)
    expect(await ord(id)).toMatchObject({ status: 'DRAFT', order_number: null, customer_id: c, total_amount: '800.00' })              // 300x2 + 10 boxes x 20
    expect(await avail(rep, s.product.id)).toEqual({ on_hand: 1000, reserved: 0, free: 1000 })
    expect((await failure(confirm(rep, id))).code).toBe('42501')                                                                          // reps draft, managers confirm
    const r = (await ok(confirm(salesMgr, id))).r
    expect(r.order_number).toMatch(/^SO-\d{4}-\d{6}$/)
    expect(await ord(id)).toMatchObject({ status: 'CONFIRMED', order_number: r.order_number, confirmed_by: salesMgr })
    expect(await avail(rep, s.product.id)).toEqual({ on_hand: 1000, reserved: 400, free: 600 })                                           // 300 + 10 boxes of 10
    expect(await progress(id)).toEqual([{ q: 300, inv: 0, draft: 0, rem: 300, res: 300 }, { q: 10, inv: 0, draft: 0, rem: 10, res: 100 }])
    expect((await failure(confirm(salesMgr, id))).message).toMatch(/only a draft order can be confirmed/)
    // a confirmed order is frozen
    for (const sql of [`update public.sales_orders set total_amount = 1, subtotal = 1, tax_total = 0 where id = $1`, `update public.sales_orders set reserved_until = current_date + 90 where id = $1`,
                       `update public.sales_order_lines set quantity = 1 where sales_order_id = $1`, `delete from public.sales_order_lines where sales_order_id = $1`, `delete from public.sales_orders where id = $1`])
      await expect(admin.query(sql, [id]), sql).rejects.toBeTruthy()
    expect((await failure(saveOrder(salesMgr, { id, customer: c, lines: [qline(s.product.id, 1)] }))).message).toMatch(/only a draft order can be edited/)
    // visibility and writes
    const visible = (user: string) => withUser(user, async (cx) => (await cx.q(`select count(*)::int n from public.sales_orders where id = $1`, [id])).rows[0].n)
    expect([await visible(rep), await visible(cashier), await visible(accounts), await visible(rep2), await visible(b.ownerId)]).toEqual([1, 1, 1, 0, 0])
    expect((await failure(call(b.ownerId, `select public.stock_availability($1, $2)`, [wh, s.product.id]))).code).toBe('P0002')
    for (const user of [owner, salesMgr]) {
      expect(await code(call(user, `delete from public.sales_orders`))).toBe('42501')
      expect(await code(call(user, `update public.sales_orders set status = 'COMPLETED' where id = $1`, [id]))).toBe('42501')
    }
  })

  it('refuses to confirm more than the free stock, counting what other orders hold; two confirmations racing for the last stock cannot both win', async () => {
    const s = await sellable(100, 2)
    const c1 = await addCustomer(); const c2 = await addCustomer()
    const first = await order(c1, [qline(s.product.id, 70)])
    const second = await order(c2, [qline(s.product.id, 50)])
    await ok(confirm(salesMgr, first))
    const refused = await failure(confirm(salesMgr, second))
    expect(refused.code).toBe('23514')
    expect(refused.message).toMatch(/not enough free stock to reserve: .*: 50 needed, 30 free \(100 sellable, 70 reserved for other orders\)/)
    expect((await ord(second)).status).toBe('DRAFT')
    // race
    const s2 = await sellable(100, 2)
    const ids = [await order(c1, [qline(s2.product.id, 80)]), await order(c2, [qline(s2.product.id, 80)])]
    const results = await Promise.all(ids.map((id) => confirm(salesMgr, id)))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect((await avail(salesMgr, s2.product.id)).reserved).toBe(80)
    // the customer's minimum shelf life is respected: short-dated stock is not reservable for them
    const picky = (await q(`insert into public.customers (organization_id, code, name, customer_type, licence_number, licence_expiry, payment_terms_days, credit_limit, min_shelf_life_days)
      values ($1, $2, 'Picky', 'PHARMACY', 'PC/2', $3, 30, 1000, 400) returning id`, [a.id, `P${rand()}`, day(300)]))[0].id
    const s3 = await sellable(100, 2)
    expect((await failure(confirm(salesMgr, await order(picky, [qline(s3.product.id, 10)])))).message).toMatch(/not enough free stock/)
  })

  it('keeps reserved stock out of other customers’ sales (invoices and the till), while the rest stays sellable', async () => {
    const s = await sellable(100, 1)
    const c1 = await addCustomer(); const c2 = await addCustomer()
    await ok(confirm(salesMgr, await order(c1, [qline(s.product.id, 70)])))
    const draft = async (customer: string, n: number) => (await ok(call(owner, `select public.save_sales_invoice(null, $1, $2, null, null, $3::jsonb) as id`, [customer, wh, JSON.stringify([qline(s.product.id, n)])]))).id as string
    const refused = await failure(postInvoice(owner, await draft(c2, 40)))
    expect(refused.code).toBe('23514')
    expect(refused.message).toMatch(/part of the stock of .* is reserved for customer orders - only 30 can be sold now \(100 sellable, 70 reserved\)/)
    await ok(postInvoice(owner, await draft(c2, 30)))                                                                                    // the free 30
    expect(await avail(salesMgr, s.product.id)).toEqual({ on_hand: 70, reserved: 70, free: 0 })
    expect((await failure(postInvoice(owner, await draft(c2, 1)))).message).toMatch(/only 0 can be sold now/)
    // the counter cannot take it either
    const sess = (await ok(call(await addUser(a.id, 'CASHIER'), `select 1`).then(async () => call(cashier, `select public.open_pos_session($1, 0) as id`, [wh])))).id
    expect((await failure(call(cashier, `select public.pos_checkout($1, null, $2::jsonb, $3::jsonb)`, [sess, JSON.stringify([qline(s.product.id, 1)]), JSON.stringify([{ method: 'CASH', amount: 5 }])]))).message).toMatch(/reserved for customer orders/)
    await ok(call(cashier, `select public.close_pos_session($1, 0, null)`, [sess]))
  })

  it('releases the reservation when the order is cancelled, closed short, or its reserved-until date passes', async () => {
    const s = await sellable(100, 1)
    const c = await addCustomer()
    const o1 = await confirmed(c, [qline(s.product.id, 40)])
    expect((await avail(salesMgr, s.product.id)).free).toBe(60)
    expect((await failure(call(rep, `select public.cancel_sales_order($1, 'x')`, [o1]))).code).toBe('42501')                             // confirmed orders: orders.manage
    expect((await failure(call(salesMgr, `select public.cancel_sales_order($1, '')`, [o1]))).code).toBe('22023')
    await ok(call(salesMgr, `select public.cancel_sales_order($1, 'Customer cancelled')`, [o1]))
    expect(await ord(o1)).toMatchObject({ status: 'CANCELLED', status_reason: 'Customer cancelled' })
    expect((await avail(salesMgr, s.product.id)).free).toBe(100)
    expect((await failure(confirm(salesMgr, o1))).message).toMatch(/only a draft order/)
    // a draft can be cancelled by whoever drafted it
    const d = await order(c, [qline(s.product.id, 1)], rep)
    await ok(call(rep, `select public.cancel_sales_order($1, 'Typo')`, [d]))
    // the date passes
    const o2 = await confirmed(c, [qline(s.product.id, 25)], day(2))
    expect((await avail(salesMgr, s.product.id)).free).toBe(75)
    const client = await admin.connect()
    try { await client.query('begin'); await client.query('set local session_replication_role = replica'); await client.query(`update public.sales_orders set reserved_until = current_date - 1 where id = $1`, [o2]); await client.query('commit') } finally { client.release() }
    expect((await avail(salesMgr, s.product.id)).free).toBe(100)
    expect((await progress(o2))[0].res).toBe(0)
    // closing short
    const o3 = await confirmed(c, [qline(s.product.id, 30)])
    const i = (await ok(invoiceOrder(salesMgr, o3, [{ order_line_id: (await q(`select id from public.sales_order_lines where sales_order_id = $1`, [o3]))[0].id, quantity: 10 }]))).id
    expect((await failure(call(salesMgr, `select public.close_sales_order($1, 'Out of stock')`, [o3]))).message).toMatch(/has draft invoices/)
    expect((await failure(call(salesMgr, `select public.cancel_sales_order($1, 'x')`, [o3]))).message).toMatch(/has draft invoices/)
    await ok(postInvoice(salesMgr, i))
    expect((await failure(call(salesMgr, `select public.cancel_sales_order($1, 'x')`, [o3]))).message).toMatch(/close it short instead/)
    expect((await avail(salesMgr, s.product.id)).reserved).toBe(20)
    await ok(call(salesMgr, `select public.close_sales_order($1, 'Customer will collect the rest elsewhere')`, [o3]))
    expect(await ord(o3)).toMatchObject({ status: 'CLOSED' })
    expect(await avail(salesMgr, s.product.id)).toEqual({ on_hand: 90, reserved: 0, free: 90 })
    expect((await failure(call(salesMgr, `select public.close_sales_order($1, 'again')`, [o3]))).message).toMatch(/closed order cannot be closed short/)
  })
})

describe('invoicing an order', () => {
  it('invoices at the order’s prices without price-override rights, ships from the reserved stock, and completes the order when everything is invoiced', async () => {
    const s = await sellable(100, 2)
    const c = await addCustomer()
    const o = await confirmed(c, [qline(s.product.id, 100)])                                    // all the stock is reserved
    await q(`update public.price_list_items set unit_price = 5 where id = $1`, [s.items[s.product.baseUnitRowId]])   // list price moves on
    const i1 = (await ok(invoiceOrder(rep, o, [{ order_line_id: (await q(`select id from public.sales_order_lines where sales_order_id = $1`, [o]))[0].id, quantity: 60 }]))).id   // a rep (no price override, no post)
    expect(await inv(i1)).toMatchObject({ status: 'DRAFT', sales_order_id: o, customer_id: c, total_amount: '120.00', branch_id: a.hq })      // 60 x the ORDER's price of 2
    expect(await progress(o)).toEqual([{ q: 100, inv: 0, draft: 60, rem: 40, res: 100 }])
    expect((await failure(call(rep, `select public.save_sales_invoice($1, $2, $3, null, null, $4::jsonb)`, [i1, c, wh, JSON.stringify([qline(s.product.id, 1)])]))).message).toMatch(/raised from a sales order and follows it/)
    expect((await failure(invoiceOrder(rep, o, [{ order_line_id: (await q(`select id from public.sales_order_lines where sales_order_id = $1`, [o]))[0].id, quantity: 41 }]))).message).toMatch(/only 40 can still be invoiced/)
    expect((await failure(postInvoice(rep, i1))).code).toBe('42501')                           // reps cannot post
    await ok(postInvoice(salesMgr, i1))                       // its own reservation is not in the way
    expect(await ord(o)).toMatchObject({ status: 'CONFIRMED' })
    expect(await progress(o)).toEqual([{ q: 100, inv: 60, draft: 0, rem: 40, res: 40 }])      // the claim shrinks as it is delivered
    expect(await avail(salesMgr, s.product.id)).toEqual({ on_hand: 40, reserved: 40, free: 0 })
    const i2 = (await ok(invoiceOrder(salesMgr, o))).id                                         // the rest, at the same order price
    expect(await inv(i2)).toMatchObject({ total_amount: '80.00' })
    await ok(postInvoice(salesMgr, i2))
    expect(await ord(o)).toMatchObject({ status: 'COMPLETED' })
    expect(await avail(salesMgr, s.product.id)).toEqual({ on_hand: 0, reserved: 0, free: 0 })
    expect((await failure(invoiceOrder(salesMgr, o))).message).toMatch(/only a confirmed order can be invoiced/)
    // an order that is not confirmed cannot be invoiced, other branches cannot, and a draft invoice can be cancelled to free its quantity
    const s2 = await sellable(100, 2)
    const d = await order(c, [qline(s2.product.id, 10)])
    expect((await failure(invoiceOrder(salesMgr, d))).message).toMatch(/only a confirmed order can be invoiced/)
    const o2 = await confirmed(c, [qline(s2.product.id, 10)])
    expect((await failure(invoiceOrder(rep2, o2))).code).toBe('42501')
    expect((await failure(invoiceOrder(accounts, o2))).code).toBe('42501')                     // no sales.create
    const di = (await ok(invoiceOrder(salesMgr, o2))).id
    expect((await failure(invoiceOrder(salesMgr, o2))).message).toMatch(/nothing left on this order to invoice/)
    await ok(call(salesMgr, `select public.cancel_sales_invoice($1, 'Not yet')`, [di]))
    expect(num((await progress(o2))[0].draft)).toBe(0)
    expect((await failure(invoiceOrder(salesMgr, o2, [{ order_line_id: '00000000-0000-0000-0000-000000000000', quantity: 1 }]))).message).toMatch(/not on this order/)
  })

  it('puts the quantity back on the order and its reservation back when an invoice is reversed', async () => {
    const s = await sellable(100, 1)
    const c = await addCustomer()
    const o = await confirmed(c, [qline(s.product.id, 100)])
    const i = (await ok(invoiceOrder(salesMgr, o))).id
    await ok(postInvoice(salesMgr, i))
    expect(await ord(o)).toMatchObject({ status: 'COMPLETED' })
    expect(await avail(salesMgr, s.product.id)).toEqual({ on_hand: 0, reserved: 0, free: 0 })
    await ok(call(owner, `select public.reverse_sales_invoice($1, 'Wrong delivery address')`, [i]))
    expect(await ord(o)).toMatchObject({ status: 'CONFIRMED' })
    expect(await avail(salesMgr, s.product.id)).toEqual({ on_hand: 100, reserved: 100, free: 0 })      // goods are back and held for the customer again
    expect(await progress(o)).toEqual([{ q: 100, inv: 0, draft: 0, rem: 100, res: 100 }])
    const i2 = (await ok(invoiceOrder(salesMgr, o))).id
    await ok(postInvoice(salesMgr, i2))
    expect(await ord(o)).toMatchObject({ status: 'COMPLETED' })
  })

  it('still applies credit control and regulatory rules when invoicing an order', async () => {
    const pom = await addProduct(a.id, { cls: 'POM' })
    await q(`insert into public.price_list_items (organization_id, price_list_id, product_id, product_unit_id, unit_price) values ($1, $2, $3, $4, 10)`, [a.id, defaultList, pom.id, pom.baseUnitRowId])
    await ok(call(owner, `select public.post_stock_document('OPENING', $1, $2::jsonb) as r`, [wh, JSON.stringify([{ product_id: pom.id, quantity: 50, batch_number: `B${rand()}`, expiry_date: day(300) }])]))
    const unlicensed = (await q(`insert into public.customers (organization_id, code, name, customer_type, payment_terms_days, credit_limit) values ($1, $2, 'Shop', 'RETAILER', 30, 100000) returning id`, [a.id, `S${rand()}`]))[0].id
    const o = await confirmed(unlicensed, [qline(pom.id, 5)])                                    // an order can be taken...
    const i = (await ok(invoiceOrder(salesMgr, o))).id
    expect((await failure(postInvoice(salesMgr, i))).message).toMatch(/is a medicine .* not a licensed pharmacy/)   // ...but not delivered
    const s = await sellable(100, 10)
    const limited = await addCustomer({ limit: 100 })
    const o2 = await confirmed(limited, [qline(s.product.id, 20)])                              // 200 against a limit of 100
    const i2 = (await ok(invoiceOrder(salesMgr, o2))).id
    expect((await failure(postInvoice(salesMgr, i2))).message).toMatch(/credit check failed/)
    expect(await ord(o2)).toMatchObject({ status: 'CONFIRMED' })
  })
})
