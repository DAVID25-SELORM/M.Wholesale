import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addProduct, addProductUnit, addUser, addWarehouse, admin, closePool, createOrg, rand, withUser, type Org } from '../helpers/db'

let a: Org
let b: Org
let wh: string
let owner: string
let accounts: string   // refunds.create + sales.reverse + credit_notes.reverse + credit_notes.post
let salesMgr: string   // refunds.create, credit_notes.create + post, NO reverse
let mgr: string        // BRANCH_MANAGER: refunds.create, pos.sell
let cashier: string    // refunds.view only
let defaultList: string
let walkIn: string

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  a = await createOrg('RFD-A')
  b = await createOrg('RFD-B')
  wh = await addWarehouse(a.id, a.hq, 'W1')
  owner = a.ownerId
  accounts = await addUser(a.id, 'ACCOUNTS_MANAGER')
  salesMgr = await addUser(a.id, 'SALES_MANAGER')
  mgr = await addUser(a.id, 'BRANCH_MANAGER')
  cashier = await addUser(a.id, 'CASHIER')
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

async function addCustomer(o: { limit?: number } = {}): Promise<string> {
  return (await q(
    `insert into public.customers (organization_id, code, name, customer_type, licence_number, licence_expiry, payment_terms_days, credit_limit)
     values ($1, $2, $3, 'PHARMACY', 'PC/1', $4, 30, $5) returning id`, [a.id, `C${rand()}`, `Customer ${rand()}`, day(300), o.limit ?? 100000]))[0].id
}
async function sellable(batches: [number, number][] = [[1000, 300]], price = 1) {
  const product = await addProduct(a.id, { cls: 'GSL' })
  const box = await addProductUnit(a.id, product.id, 'BOX', 10)
  for (const [unit, p] of [[product.baseUnitRowId, price], [box, price * 10]] as const) {
    await q(`insert into public.price_list_items (organization_id, price_list_id, product_id, product_unit_id, unit_price) values ($1, $2, $3, $4, $5)`, [a.id, defaultList, product.id, unit, p])
  }
  let i = 0
  for (const [qty, exp] of batches) {
    await ok(call(owner, `select public.post_stock_document('OPENING', $1, $2::jsonb) as r`, [wh, JSON.stringify([{ product_id: product.id, quantity: qty, batch_number: `B${rand()}${++i}`, expiry_date: day(exp) }])]))
  }
  const batchIds = (await q(`select id from public.batches where product_id = $1 order by expiry_date`, [product.id])).map((r) => r.id as string)
  return { product, box, batchIds }
}
const stock = async (productId: string, status = 'AVAILABLE') =>
  num((await q(`select coalesce(sum(quantity),0) n from public.stock_balances where product_id = $1 and stock_status = $2`, [productId, status]))[0].n)
const ledgerBalanced = async (productId: string) =>
  expect(await q(`select 1 from (select sb.quantity, (select coalesce(sum(m.quantity),0) from public.stock_movements m where m.warehouse_id = sb.warehouse_id and m.product_id = sb.product_id
        and m.batch_id is not distinct from sb.batch_id and m.location_id is not distinct from sb.location_id and m.stock_status = sb.stock_status) s
        from public.stock_balances sb where sb.product_id = $1) x where x.quantity <> x.s`, [productId])).toEqual([])

async function invoice(customer: string, lines: object[], pay: number | null = null): Promise<string> {
  const id = (await ok(call(owner, `select public.save_sales_invoice(null, $1, $2, null, null, $3::jsonb) as id`, [customer, wh, JSON.stringify(lines)]))).id
  await ok(call(owner, `select public.post_sales_invoice($1, null, $2::jsonb) as r`, [id, pay === null ? null : JSON.stringify({ amount: pay, method: 'CASH' })]))
  return id
}
const inv = async (id: string) => (await q(`select * from public.sales_invoices where id = $1`, [id]))[0]
const invLines = async (id: string) => q(`select * from public.sales_invoice_lines where sales_invoice_id = $1 order by line_no`, [id])
const note = async (id: string) => (await q(`select * from public.sales_credit_notes where id = $1`, [id]))[0]
const receipt = async (id: string) => (await q(`select * from public.customer_receipts where id = $1`, [id]))[0]
/** A posted credit note returning `qty` of the invoice's first line (quarantine unless told otherwise). */
async function creditNote(invoiceId: string, qty: number, condition = 'QUARANTINE'): Promise<string> {
  const [l] = await invLines(invoiceId)
  const n = (await ok(call(salesMgr, `select public.save_credit_note(null, $1, null, 'DAMAGED', null, $2::jsonb) as id`, [invoiceId, JSON.stringify([{ type: 'RETURN', invoice_line_id: l.id, quantity: qty, condition }])]))).id
  await ok(call(salesMgr, `select public.post_credit_note($1) as r`, [n]))
  return n
}
const refund = (user: string, type: string, id: string, amount: number, method = 'MOBILE_MONEY', reference: string | null = 'MM-1', session: string | null = null) =>
  call(user, `select public.refund_customer($1, $2, $3, $4, $5, null, $6) as r`, [type, id, amount, method, reference, session])
const credit = async (user: string, customer: string) => (await ok(call(user, `select * from public.customer_credit($1)`, [customer])))

describe('refunds', () => {
  it('pays back unused credit-note credit, reducing it, with a reference for non-cash, and shows on the statement', async () => {
    const s = await sellable()
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 100 }], 100)            // paid in full
    const n = await creditNote(i, 40)                                                          // 40 of credit, nothing owed to apply it to
    expect(num((await note(n)).unapplied_amount)).toBe(40)
    expect(num((await credit(accounts, c)).credit_held)).toBe(40)

    expect((await failure(refund(cashier, 'CREDIT_NOTE', n, 10))).code).toBe('42501')          // cashiers cannot refund
    expect((await failure(refund(accounts, 'CREDIT_NOTE', n, 41))).message).toMatch(/only 40\.00 of this credit is unused/)
    expect((await failure(refund(accounts, 'CREDIT_NOTE', n, 10, 'MOBILE_MONEY', null))).message).toMatch(/enter the reference/)
    expect((await failure(refund(accounts, 'CREDIT_NOTE', n, 10, 'BARTER'))).code).toBe('22023')
    expect((await failure(refund(accounts, 'CREDIT_NOTE', n, 0))).code).toBe('22023')
    expect((await failure(refund(accounts, 'CREDIT_NOTE', n, 1.005))).code).toBe('22023')
    expect((await failure(refund(accounts, 'PURCHASE', n, 10))).code).toBe('22023')
    expect((await failure(refund(b.ownerId, 'CREDIT_NOTE', n, 10))).code).toBe('P0002')

    const r = (await ok(refund(accounts, 'CREDIT_NOTE', n, 25))).r
    expect(r.refund_number).toMatch(/^RFD-\d{4}-\d{6}$/)
    expect(await note(n)).toMatchObject({ refunded_amount: '25.00', applied_amount: '0.00', unapplied_amount: '15.00' })
    expect(num((await credit(accounts, c)).credit_held)).toBe(15)
    const st = (await ok(call(accounts, `select jsonb_agg(jsonb_build_object('t', entry_type, 'd', debit::float8, 'c', credit::float8, 'b', balance::float8) order by entry_date, entry_type) as rows from public.customer_statement($1)`, [c]))).rows
    expect(st.find((x: any) => x.t === 'REFUND')).toMatchObject({ d: 25, c: 0 })
    expect(st[st.length - 1].b).toBe(-15)                                                      // the customer is still owed 15
    // unused credit can still be applied or refunded, but never beyond what is left
    await ok(refund(accounts, 'CREDIT_NOTE', n, 15, 'CASH', null))
    expect((await failure(refund(accounts, 'CREDIT_NOTE', n, 1))).message).toMatch(/only 0\.00 of this credit/)
    expect((await failure(call(accounts, `select public.apply_credit_note($1)`, [n]))).message).toMatch(/nothing left to apply/)
    expect(num((await credit(accounts, c)).credit_held)).toBe(0)
    // append-only and unreachable
    const id = (await q(`select id from public.customer_refunds where credit_note_id = $1 limit 1`, [n]))[0].id
    for (const sql of [`update public.customer_refunds set amount = 1 where id = $1`, `delete from public.customer_refunds where id = $1`]) await expect(admin.query(sql, [id])).rejects.toBeTruthy()
    for (const user of [owner, accounts]) {
      expect(await code(call(user, `delete from public.customer_refunds`))).toBe('42501')
      expect(await code(call(user, `insert into public.customer_refunds (organization_id) values ($1)`, [a.id]))).toBe('42501')
    }
    await ledgerBalanced(s.product.id)
  })

  it('pays back a payment that was never allocated, and then that payment can no longer be voided or over-allocated', async () => {
    const s = await sellable()
    const c = await addCustomer()
    const rid = (await ok(call(owner, `select (public.record_receipt($1, $2, 100, 'CASH', null, null, null)->>'receipt_id') as id`, [c, a.hq]))).id
    expect(num((await receipt(rid)).unallocated_amount)).toBe(100)
    await ok(refund(accounts, 'RECEIPT', rid, 60, 'CASH', null))
    expect(await receipt(rid)).toMatchObject({ refunded_amount: '60.00', unallocated_amount: '40.00', status: 'POSTED' })
    expect((await failure(call(owner, `select public.void_receipt($1, 'oops')`, [rid]))).message).toMatch(/has been refunded to the customer, so it cannot be voided/)
    expect((await failure(refund(accounts, 'RECEIPT', rid, 41))).message).toMatch(/only 40\.00/)
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 100 }])
    expect(num((await ok(call(owner, `select public.allocate_receipt($1) as r`, [rid]))).r.allocated)).toBe(40)    // only what was not refunded
    expect(await inv(i)).toMatchObject({ amount_paid: '40.00', balance_due: '60.00' })
    // a voided payment cannot be refunded
    const rid2 = (await ok(call(owner, `select (public.record_receipt($1, $2, 10, 'CASH', null, null, null)->>'receipt_id') as id`, [c, a.hq]))).id
    await ok(call(owner, `select public.void_receipt($1, 'bounced')`, [rid2]))
    expect((await failure(refund(accounts, 'RECEIPT', rid2, 5))).message).toMatch(/only a posted payment/)
  })

  it('pays a cash refund out of the cashier’s own till shift, which then expects less cash', async () => {
    const s = await sellable()
    const sess = (await ok(call(mgr, `select public.open_pos_session($1, 100) as id`, [wh]))).id
    const sale = (await ok(call(mgr, `select public.pos_checkout($1, null, $2::jsonb, $3::jsonb) as r`, [sess, JSON.stringify([{ product_id: s.product.id, quantity: 30 }]), JSON.stringify([{ method: 'CASH', amount: 30 }])]))).r
    const sum = async () => num((await ok(call(mgr, `select public.pos_session_summary($1) as r`, [sess]))).r.expected_cash)
    expect(await sum()).toBe(130)
    await ok(call(accounts, `select public.reverse_sales_invoice($1, 'Customer returned everything, sale cancelled')`, [sale.invoice_id]))
    const rid = (await q(`select receipt_id from public.pos_sale_payments where pos_sale_id = $1`, [sale.pos_sale_id]))[0].receipt_id
    expect(num((await receipt(rid)).unallocated_amount)).toBe(30)                                // the walk-in's money is credit again
    expect(await sum()).toBe(130)                                                               // until it is actually handed back
    expect((await failure(refund(mgr, 'RECEIPT', rid, 30, 'MOBILE_MONEY', 'MM9', sess))).message).toMatch(/only a cash refund/)
    expect((await failure(refund(salesMgr, 'RECEIPT', rid, 30, 'CASH', null, sess))).message).toMatch(/choose your own open till shift/)
    await ok(refund(mgr, 'RECEIPT', rid, 30, 'CASH', null, sess))
    expect(await sum()).toBe(100)
    const closed = (await ok(call(mgr, `select public.close_pos_session($1, 100, null) as r`, [sess]))).r
    expect([num(closed.variance), num(closed.expected_cash)]).toEqual([0, 100])
    expect((await failure(refund(mgr, 'RECEIPT', rid, 1, 'CASH', null, sess))).message).toMatch(/choose your own open till shift|only 0\.00/)
  })
})

describe('reversing a sales invoice', () => {
  it('returns the goods to their batches, turns payments back into credit, and keeps the invoice on file as reversed', async () => {
    const s = await sellable([[100, 100], [100, 400]])
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 150 }], 60)             // 150 owed, 60 paid
    expect(await stock(s.product.id)).toBe(50)
    const before = await q(`select batch_id, quantity::float8 q from public.stock_balances where product_id = $1 order by batch_id`, [s.product.id])
    expect(before.length).toBeGreaterThan(0)
    expect((await failure(call(salesMgr, `select public.reverse_sales_invoice($1, 'x')`, [i]))).code).toBe('42501')
    expect((await failure(call(accounts, `select public.reverse_sales_invoice($1, '')`, [i]))).code).toBe('22023')
    expect((await failure(call(b.ownerId, `select public.reverse_sales_invoice($1, 'x')`, [i]))).code).toBe('P0002')
    const r = (await ok(call(accounts, `select public.reverse_sales_invoice($1, 'Wrong customer') as r`, [i]))).r
    expect([r.invoice_number, num(r.credit_released)]).toEqual([(await inv(i)).invoice_number, 60])
    expect(r.stock_document_number).toMatch(/^SRV-/)
    expect(await stock(s.product.id)).toBe(200)
    expect(await q(`select b.batch_number, sum(sb.quantity)::float8 q from public.stock_balances sb join public.batches b on b.id = sb.batch_id where sb.product_id = $1 and sb.stock_status = 'AVAILABLE' group by b.batch_number order by 1`, [s.product.id]).then((x) => x.map((y) => y.q))).toEqual([100, 100])
    expect(await inv(i)).toMatchObject({ status: 'REVERSED', amount_paid: '0.00', balance_due: '150.00', reversal_reason: 'Wrong customer' })
    expect((await q(`select d.document_type, d.reason_code, d.source_type from public.stock_documents d where d.id = $1`, [(await inv(i)).reversal_document_id]))[0]).toEqual({ document_type: 'SALE_REVERSAL', reason_code: 'REVERSAL', source_type: 'SALES_INVOICE' })
    // the customer owes nothing for it, and keeps the 60 as credit
    const pos = await credit(accounts, c)
    expect([num(pos.outstanding), num(pos.credit_held)]).toEqual([0, 60])
    const st = (await ok(call(accounts, `select jsonb_agg(jsonb_build_object('t', entry_type, 'd', debit::float8, 'c', credit::float8, 'b', balance::float8) order by entry_date, at_sort) as rows from (select s.*, row_number() over () at_sort from public.customer_statement($1) s) x`, [c]))).rows
    expect(st.map((x: any) => x.t).sort()).toEqual(['INVOICE', 'RECEIPT', 'REVERSAL'])
    expect(st[st.length - 1].b).toBe(-60)
    // it cannot be reversed again, credited, paid, or edited; the invoice stays unchangeable
    expect((await failure(call(accounts, `select public.reverse_sales_invoice($1, 'again')`, [i]))).message).toMatch(/only a posted invoice can be reversed \(this one is REVERSED\)/)
    const [l] = await invLines(i)
    expect((await failure(call(salesMgr, `select public.save_credit_note(null, $1, null, 'OTHER', null, $2::jsonb)`, [i, JSON.stringify([{ type: 'PRICE', invoice_line_id: l.id, amount: 1 }])]))).message).toMatch(/only a posted invoice can be credited/)
    expect((await failure(call(owner, `select public.record_receipt($1, $2, 10, 'CASH', null, $3::jsonb, null)`, [c, a.hq, JSON.stringify([{ invoice_id: i, amount: 10 }])]))).message).toMatch(/only a posted invoice can be paid/)
    for (const sql of [`update public.sales_invoices set total_amount = 1, subtotal = 1, tax_total = 0 where id = $1`, `update public.sales_invoices set status = 'POSTED' where id = $1`, `delete from public.sales_invoices where id = $1`])
      await expect(admin.query(sql, [i]), sql).rejects.toBeTruthy()
    // the 60 can be applied to another invoice, or refunded
    const i2 = await invoice(c, [{ product_id: s.product.id, quantity: 20 }])
    const rid = (await q(`select r.id from public.customer_receipts r where r.customer_id = $1`, [c]))[0].id
    expect(num((await ok(call(owner, `select public.allocate_receipt($1) as r`, [rid]))).r.allocated)).toBe(20)
    expect(await inv(i2)).toMatchObject({ balance_due: '0.00' })
    await ok(refund(accounts, 'RECEIPT', rid, 40, 'BANK_TRANSFER', 'TRF-1'))
    expect(num((await credit(accounts, c)).credit_held)).toBe(0)
    await ledgerBalanced(s.product.id)
  })

  it('puts goods from a batch that expired meanwhile back as expired stock, never sellable', async () => {
    const s = await sellable([[100, 3]])
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 40 }])
    const client = await admin.connect()
    try {
      await client.query('begin')
      await client.query('set local session_replication_role = replica')
      await client.query(`update public.batches set expiry_date = $2 where id = $1`, [s.batchIds[0], day(-1)])
      await client.query('commit')
    } finally { client.release() }
    await ok(call(accounts, `select public.reverse_sales_invoice($1, 'Cancelled')`, [i]))
    expect([await stock(s.product.id), await stock(s.product.id, 'EXPIRED')]).toEqual([60, 40])
    await ledgerBalanced(s.product.id)
  })

  it('refuses while the invoice has credit notes, and works once they are reversed', async () => {
    const s = await sellable()
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 100 }])
    const n = await creditNote(i, 10)
    expect((await failure(call(accounts, `select public.reverse_sales_invoice($1, 'x')`, [i]))).message).toMatch(/has credit notes: reverse them first/)
    await ok(call(accounts, `select public.reverse_credit_note($1, 'Mistake') as r`, [n]))
    await ok(call(accounts, `select public.reverse_sales_invoice($1, 'Cancelled') as r`, [i]))
    expect(await stock(s.product.id)).toBe(1000)
    expect(await stock(s.product.id, 'QUARANTINE')).toBe(0)
    await ledgerBalanced(s.product.id)
  })

  it('keeps a reversed counter sale out of what the walk-in owes and refuses a second reversal under concurrency', async () => {
    const s = await sellable()
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 10 }])
    const results = await Promise.all([call(accounts, `select public.reverse_sales_invoice($1, 'a') as r`, [i]), call(owner, `select public.reverse_sales_invoice($1, 'b') as r`, [i])])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(await stock(s.product.id)).toBe(1000)                                               // the goods came back exactly once
    expect(num((await credit(accounts, c)).outstanding)).toBe(0)
    expect(walkIn).toBeTruthy()
  })
})

describe('reversing a credit note', () => {
  it('takes the returned goods back out of stock and reopens what the credit note had cleared', async () => {
    const s = await sellable()
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 100 }])                 // 100 owed
    const n = await creditNote(i, 30)
    expect(await inv(i)).toMatchObject({ amount_credited: '30.00', balance_due: '70.00' })
    expect(await stock(s.product.id, 'QUARANTINE')).toBe(30)
    expect((await failure(call(salesMgr, `select public.reverse_credit_note($1, 'x')`, [n]))).code).toBe('42501')
    expect((await failure(call(accounts, `select public.reverse_credit_note($1, '')`, [n]))).code).toBe('22023')
    const r = (await ok(call(accounts, `select public.reverse_credit_note($1, 'Issued in error') as r`, [n]))).r
    expect([r.credit_note_number, num(r.reopened)]).toEqual([(await note(n)).credit_note_number, 30])
    expect(r.stock_document_number).toMatch(/^CRV-/)
    expect(await stock(s.product.id, 'QUARANTINE')).toBe(0)
    expect(await inv(i)).toMatchObject({ amount_credited: '0.00', balance_due: '100.00' })
    expect(await note(n)).toMatchObject({ status: 'REVERSED', reversal_reason: 'Issued in error' })
    expect(num((await credit(accounts, c)).credit_held)).toBe(0)
    expect((await failure(call(accounts, `select public.reverse_credit_note($1, 'again')`, [n]))).message).toMatch(/only a posted credit note can be reversed \(this one is REVERSED\)/)
    for (const sql of [`update public.sales_credit_notes set status = 'POSTED' where id = $1`, `update public.sales_credit_notes set total_amount = 1, subtotal = 1, tax_total = 0 where id = $1`])
      await expect(admin.query(sql, [n]), sql).rejects.toBeTruthy()
    // the goods can be credited again now
    const [l] = await invLines(i)
    expect(await code(call(salesMgr, `select public.save_credit_note(null, $1, null, 'DAMAGED', null, $2::jsonb)`, [i, JSON.stringify([{ type: 'RETURN', invoice_line_id: l.id, quantity: 100 }])]))).toBe('ok')
    const st = (await ok(call(accounts, `select jsonb_agg(entry_type) as t from public.customer_statement($1)`, [c]))).t
    expect(st.filter((x: string) => x === 'CREDIT_NOTE')).toHaveLength(1)
    expect(st.filter((x: string) => x === 'REVERSAL')).toHaveLength(1)
    await ledgerBalanced(s.product.id)
  })

  it('refuses when the returned goods are no longer there, leaving everything as it was', async () => {
    const s = await sellable()
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 100 }])
    const n = await creditNote(i, 30)
    // the quarantined goods are inspected, released and sold on
    const bal = (await q(`select batch_id, location_id from public.stock_balances where product_id = $1 and stock_status = 'QUARANTINE'`, [s.product.id]))[0]
    await ok(call(owner, `select public.post_stock_document('STATUS_CHANGE', $1, $2::jsonb, null, 'QUALITY_RELEASE') as r`, [wh, JSON.stringify([{ product_id: s.product.id, batch_id: bal.batch_id, quantity: 30, status: 'QUARANTINE', to_status: 'AVAILABLE' }])]))
    const refused = await failure(call(accounts, `select public.reverse_credit_note($1, 'Issued in error')`, [n]))
    expect(refused.code).toBe('23514')
    expect(refused.message).toMatch(/insufficient stock/)
    expect(await note(n)).toMatchObject({ status: 'POSTED' })
    expect(await inv(i)).toMatchObject({ amount_credited: '30.00' })
    expect(await stock(s.product.id)).toBe(930)
    await ledgerBalanced(s.product.id)
  })

  it('cannot be reversed once part of it was refunded; a price-only credit note reverses without touching stock', async () => {
    const s = await sellable()
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 100 }], 100)
    const n = await creditNote(i, 20)
    await ok(refund(accounts, 'CREDIT_NOTE', n, 5))
    expect((await failure(call(accounts, `select public.reverse_credit_note($1, 'x')`, [n]))).message).toMatch(/has been refunded to the customer, so it cannot be reversed/)
    const [l] = await invLines(i)
    const price = (await ok(call(salesMgr, `select public.save_credit_note(null, $1, null, 'PRICE_ERROR', null, $2::jsonb) as id`, [i, JSON.stringify([{ type: 'PRICE', invoice_line_id: l.id, amount: 10 }])]))).id
    await ok(call(salesMgr, `select public.post_credit_note($1)`, [price]))
    const r = (await ok(call(accounts, `select public.reverse_credit_note($1, 'Wrong rebate') as r`, [price]))).r
    expect(r.stock_document_number).toBeNull()
    expect(await note(price)).toMatchObject({ status: 'REVERSED' })
    expect(num((await credit(accounts, c)).credit_held)).toBe(15)                              // only the first note's unrefunded 15 remains
  })

  it('reverses a note whose credit was applied to a different invoice, reopening that invoice', async () => {
    const s = await sellable()
    const c = await addCustomer()
    const paid = await invoice(c, [{ product_id: s.product.id, quantity: 100 }], 100)
    const open = await invoice(c, [{ product_id: s.product.id, quantity: 50 }])
    const n = await creditNote(paid, 40)                                                       // 40 credit, held
    await ok(call(accounts, `select public.apply_credit_note($1) as r`, [n]))                  // applied to the open invoice
    expect(await inv(open)).toMatchObject({ amount_credited: '40.00', balance_due: '10.00' })
    await ok(call(accounts, `select public.reverse_credit_note($1, 'Mistake')`, [n]))
    expect(await inv(open)).toMatchObject({ amount_credited: '0.00', balance_due: '50.00' })
    expect(await q(`select is_reversed from public.credit_note_allocations where credit_note_id = $1`, [n])).toEqual([{ is_reversed: true }])
    await ledgerBalanced(s.product.id)
  })
})
