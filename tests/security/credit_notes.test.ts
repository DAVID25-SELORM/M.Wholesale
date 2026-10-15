import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBranch, addProduct, addProductUnit, addUser, addWarehouse, admin, closePool, createOrg, rand, withUser, type Org } from '../helpers/db'

let a: Org
let b: Org
let wh: string
let branch2: string
let wh2: string
let owner: string
let salesMgr: string   // credit_notes.create + post, no restock
let rep: string        // credit_notes.create only
let accounts: string   // credit_notes.post only (+ receipts, override_credit)
let whMgr: string      // credit_notes.create + restock, no post
let rep2: string       // branch 2 only
let defaultList: string

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  a = await createOrg('CRN-A')
  b = await createOrg('CRN-B')
  wh = await addWarehouse(a.id, a.hq, 'W1')
  branch2 = await addBranch(a.id, 'B2')
  wh2 = await addWarehouse(a.id, branch2, 'W2')
  owner = a.ownerId
  salesMgr = await addUser(a.id, 'SALES_MANAGER')
  rep = await addUser(a.id, 'SALES_REP')
  accounts = await addUser(a.id, 'ACCOUNTS_MANAGER')
  whMgr = await addUser(a.id, 'WAREHOUSE_MANAGER')
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

async function addCustomer(o: { limit?: number; terms?: number } = {}): Promise<string> {
  return (await q(
    `insert into public.customers (organization_id, code, name, customer_type, licence_number, licence_expiry, payment_terms_days, credit_limit)
     values ($1, $2, $3, 'PHARMACY', 'PC/1', $4, $5, $6) returning id`, [a.id, `C${rand()}`, `Customer ${rand()}`, day(300), o.terms ?? 30, o.limit ?? 100000]))[0].id
}
/** A GSL product priced `price` per base unit (box of 10 at 10x), with stock in `wh`; batches: [qty, expiry offset in days]. */
async function sellable(batches: [number, number][], o: { price?: number; taxRate?: number } = {}) {
  const product = await addProduct(a.id, { cls: 'GSL' })
  const box = await addProductUnit(a.id, product.id, 'BOX', 10)
  if (o.taxRate) {
    const tax = (await q(`insert into public.tax_codes (organization_id, code, name, rate) values ($1, $2, 'Tax', $3) returning id`, [a.id, `T${rand()}`, o.taxRate]))[0].id
    await q(`update public.products set tax_code_id = $2 where id = $1`, [product.id, tax])
  }
  for (const [unit, price] of [[product.baseUnitRowId, o.price ?? 2], [box, (o.price ?? 2) * 10]] as const) {
    await q(`insert into public.price_list_items (organization_id, price_list_id, product_id, product_unit_id, unit_price) values ($1, $2, $3, $4, $5)`, [a.id, defaultList, product.id, unit, price])
  }
  let i = 0
  const batchIds: string[] = []
  for (const [qty, exp] of batches) {
    await ok(call(owner, `select public.post_stock_document('OPENING', $1, $2::jsonb) as r`, [wh, JSON.stringify([{ product_id: product.id, quantity: qty, batch_number: `B${rand()}${++i}`, expiry_date: day(exp) }])]))
  }
  for (const r of await q(`select id from public.batches where product_id = $1 order by expiry_date`, [product.id])) batchIds.push(r.id)
  return { product, box, batchIds }
}
const onHand = async (productId: string, status = 'AVAILABLE') =>
  Number((await q(`select coalesce(sum(quantity),0) n from public.stock_balances where product_id = $1 and stock_status = $2`, [productId, status]))[0].n)
const ledgerBalanced = async (productId: string) =>
  expect(await q(`select 1 from (select sb.quantity, (select coalesce(sum(m.quantity),0) from public.stock_movements m where m.warehouse_id = sb.warehouse_id and m.product_id = sb.product_id
        and m.batch_id is not distinct from sb.batch_id and m.location_id is not distinct from sb.location_id and m.stock_status = sb.stock_status) s
        from public.stock_balances sb where sb.product_id = $1) x where x.quantity <> x.s`, [productId])).toEqual([])

/** Posts an invoice for `lines` and returns its id (the customer owes the total unless `pay` is given). */
async function invoice(customer: string, lines: object[], pay: number | null = null): Promise<string> {
  const id = (await ok(call(owner, `select public.save_sales_invoice(null, $1, $2, null, null, $3::jsonb) as id`, [customer, wh, JSON.stringify(lines)]))).id
  await ok(call(owner, `select public.post_sales_invoice($1, null, $2::jsonb) as r`, [id, pay === null ? null : JSON.stringify({ amount: pay, method: 'CASH' })]))
  return id
}
const inv = async (id: string) => (await q(`select * from public.sales_invoices where id = $1`, [id]))[0]
const invLines = async (id: string) => q(`select * from public.sales_invoice_lines where sales_invoice_id = $1 order by line_no`, [id])
const save = (user: string, o: { id?: string | null; invoice: string; wh?: string | null; reason?: string; lines: object[] }) =>
  call(user, `select public.save_credit_note($1, $2, $3, $4, null, $5::jsonb) as id`, [o.id ?? null, o.invoice, o.wh ?? null, o.reason ?? 'DAMAGED', JSON.stringify(o.lines)])
const draft = async (invoiceId: string, lines: object[], user = salesMgr, reason = 'DAMAGED') => (await ok(save(user, { invoice: invoiceId, lines, reason }))).id as string
const post = (user: string, id: string) => call(user, `select public.post_credit_note($1) as r`, [id])
const note = async (id: string) => (await q(`select * from public.sales_credit_notes where id = $1`, [id]))[0]
const num = (v: unknown) => Number(v)

describe('credit notes: returning goods', () => {
  it('credits a whole line at the price charged, returns the stock to quarantine in the batch it came from, and clears the debt', async () => {
    const s = await sellable([[500, 300]], { price: 2 })
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 100 }])         // 200.00 owed
    const [l] = await invLines(i)
    expect(await onHand(s.product.id)).toBe(400)

    const n = await draft(i, [{ type: 'RETURN', invoice_line_id: l.id, quantity: 100 }])
    expect(await note(n)).toMatchObject({ status: 'DRAFT', credit_note_number: null, customer_id: c, branch_id: a.hq, warehouse_id: wh })
    expect(num((await note(n)).total_amount)).toBe(200)
    expect(await onHand(s.product.id, 'QUARANTINE')).toBe(0)                           // a draft moves nothing

    const r = (await ok(post(salesMgr, n))).r
    expect(r.credit_note_number).toMatch(/^CRN-\d{4}-\d{6}$/)
    expect([num(r.total_amount), num(r.applied), num(r.unapplied)]).toEqual([200, 200, 0])
    expect(await onHand(s.product.id)).toBe(400)                                       // not sellable until inspected
    expect(await onHand(s.product.id, 'QUARANTINE')).toBe(100)
    const back = await q(`select r.*, m.movement_type, d.document_type, d.reason_code, d.source_type from public.sales_credit_note_returns r
      join public.sales_credit_notes n on n.id = r.credit_note_id join public.stock_documents d on d.id = n.stock_document_id
      join public.stock_movements m on m.document_id = d.id where r.credit_note_id = $1`, [n])
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ batch_id: s.batchIds[0], return_condition: 'QUARANTINE', movement_type: 'SALE_RETURN_IN', document_type: 'SALE_RETURN', reason_code: 'RETURN_FROM_CUSTOMER', source_type: 'CREDIT_NOTE' })
    expect(await inv(i)).toMatchObject({ amount_credited: '200.00', balance_due: '0.00', amount_paid: '0.00' })
    expect(await note(n)).toMatchObject({ status: 'POSTED', applied_amount: '200.00', unapplied_amount: '0.00' })
    await ledgerBalanced(s.product.id)
  })

  it('returns part of a line, in packs, with tax at the line’s rate, and caps what can be credited across credit notes', async () => {
    const s = await sellable([[1000, 300]], { price: 3, taxRate: 10 })
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, product_unit_id: s.box, quantity: 5 }])    // 5 boxes x 30 = 150 + 15 tax
    const [l] = await invLines(i)
    expect([num(l.line_net), num(l.line_tax)]).toEqual([150, 15])
    const n1 = await draft(i, [{ type: 'RETURN', invoice_line_id: l.id, quantity: 2 }])
    expect([num((await note(n1)).subtotal), num((await note(n1)).tax_total), num((await note(n1)).total_amount)]).toEqual([60, 6, 66])
    await ok(post(salesMgr, n1))
    expect(await onHand(s.product.id, 'QUARANTINE')).toBe(20)                                          // 2 boxes = 20 base units
    expect(await inv(i)).toMatchObject({ amount_credited: '66.00', balance_due: '99.00' })
    // the remaining 3 boxes: asking for 4 is refused with the true remainder
    const tooMuch = await failure(save(salesMgr, { invoice: i, lines: [{ type: 'RETURN', invoice_line_id: l.id, quantity: 4 }] }))
    expect(tooMuch.code).toBe('22023')
    expect(tooMuch.message).toMatch(/only 3 can still be returned/)
    const n2 = await draft(i, [{ type: 'RETURN', invoice_line_id: l.id, quantity: 3 }])
    expect(num((await note(n2)).total_amount)).toBe(99)                                                 // the last of the line: exactly what remains, to the cent
    await ok(post(salesMgr, n2))
    expect(await inv(i)).toMatchObject({ amount_credited: '165.00', balance_due: '0.00' })
    expect((await failure(save(salesMgr, { invoice: i, lines: [{ type: 'RETURN', invoice_line_id: l.id, quantity: 1 }] }))).message).toMatch(/only 0 can still be returned/)
    await ledgerBalanced(s.product.id)
  })

  it('splits a return over the batches sold, last-picked first, or from a chosen batch', async () => {
    const s = await sellable([[100, 100], [100, 400]], { price: 1 })                  // FEFO: sells 100 from the early batch, then 50 from the later one
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 150 }])
    const [l] = await invLines(i)
    const n1 = await draft(i, [{ type: 'RETURN', invoice_line_id: l.id, quantity: 70 }])
    await ok(post(salesMgr, n1))
    const rows = await q(`select batch_id, base_quantity::float8 q from public.sales_credit_note_returns where credit_note_id = $1 order by base_quantity desc`, [n1])
    expect(rows).toEqual([{ batch_id: s.batchIds[1], q: 50 }, { batch_id: s.batchIds[0], q: 20 }])   // the later batch (50) first, then 20 of the early one
    // a chosen batch: the later batch is fully returned already, so asking for one more unit from it cannot be traced
    const n2 = await draft(i, [{ type: 'RETURN', invoice_line_id: l.id, quantity: 1, batch_id: s.batchIds[1] }])
    const refused = await failure(post(salesMgr, n2))
    expect(refused.code).toBe('22023')
    expect(refused.message).toMatch(/cannot be traced back to the batches sold/)
    const n3 = await draft(i, [{ type: 'RETURN', invoice_line_id: l.id, quantity: 80, batch_id: s.batchIds[0] }])
    await ok(post(salesMgr, n3))
    expect(await onHand(s.product.id, 'QUARANTINE')).toBe(150)
    expect((await failure(save(salesMgr, { invoice: i, lines: [{ type: 'RETURN', invoice_line_id: l.id, quantity: 1 }] }))).message).toMatch(/only 0 can still be returned/)
    await ledgerBalanced(s.product.id)
  })

  it('refuses a batch that was not sold on the line, bad quantities and conditions, and non-posted invoices', async () => {
    const s = await sellable([[100, 100]], { price: 1 })
    const other = await sellable([[100, 100]], { price: 1 })
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 10 }])
    const [l] = await invLines(i)
    const bad = (line: object) => failure(save(salesMgr, { invoice: i, lines: [{ type: 'RETURN', invoice_line_id: l.id, ...line }] }))
    expect((await bad({ quantity: 1, batch_id: other.batchIds[0] })).code).toBe('P0002')
    expect((await bad({ quantity: 0 })).code).toBe('22023')
    expect((await bad({ quantity: 0.0001 })).code).toBe('22023')
    expect((await bad({ quantity: 1, condition: 'GOOD' })).code).toBe('22023')
    expect((await bad({ quantity: 11 })).message).toMatch(/only 10 can still be returned/)
    expect((await failure(save(salesMgr, { invoice: i, lines: [{ type: 'EXCHANGE', invoice_line_id: l.id, quantity: 1 }] }))).code).toBe('22023')
    expect((await failure(save(salesMgr, { invoice: i, lines: [{ type: 'RETURN', invoice_line_id: (await invLines(await invoice(c, [{ product_id: other.product.id, quantity: 1 }])))[0].id, quantity: 1 }] }))).code).toBe('P0002')   // another invoice's line
    expect((await failure(save(salesMgr, { invoice: i, reason: 'BECAUSE', lines: [{ type: 'RETURN', invoice_line_id: l.id, quantity: 1 }] }))).code).toBe('22023')
    expect((await failure(save(salesMgr, { invoice: i, lines: [] }))).code).toBe('22023')
    const drafted = (await ok(call(owner, `select public.save_sales_invoice(null, $1, $2, null, null, $3::jsonb) as id`, [c, wh, JSON.stringify([{ product_id: s.product.id, quantity: 1 }])]))).id
    expect((await failure(save(salesMgr, { invoice: drafted, lines: [{ type: 'RETURN', invoice_line_id: (await invLines(drafted))[0].id, quantity: 1 }] }))).message).toMatch(/only a posted invoice can be credited/)
  })
})

describe('credit notes: stock condition and permissions', () => {
  it('returns to quarantine or damaged by default, and only people with credit_notes.restock may return goods straight to sellable stock', async () => {
    const s = await sellable([[200, 300]], { price: 1 })
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 100 }])
    const [l] = await invLines(i)
    expect(await onHand(s.product.id)).toBe(100)
    const direct = [{ type: 'RETURN', invoice_line_id: l.id, quantity: 10, condition: 'AVAILABLE' }]
    expect((await failure(save(salesMgr, { invoice: i, lines: direct }))).code).toBe('42501')   // sales manager can draft and post, but not restock
    const n1 = await draft(i, direct, whMgr)                                                      // the warehouse manager can
    expect((await failure(post(whMgr, n1))).code).toBe('42501')                                   // ...but cannot post
    expect((await failure(save(salesMgr, { id: n1, invoice: i, lines: direct }))).code).toBe('42501')   // and nobody without restock can re-save it as sellable
    await ok(post(salesMgr, n1))                                                                  // posting needs credit_notes.post only: the drafter already vouched for the condition
    expect(await onHand(s.product.id)).toBe(110)
    const n2 = await draft(i, [{ type: 'RETURN', invoice_line_id: l.id, quantity: 20, condition: 'DAMAGED' }])
    await ok(post(salesMgr, n2))
    expect(await onHand(s.product.id, 'DAMAGED')).toBe(20)
    const n3 = await draft(i, [{ type: 'RETURN', invoice_line_id: l.id, quantity: 5 }])
    await ok(post(salesMgr, n3))
    expect(await onHand(s.product.id, 'QUARANTINE')).toBe(5)
    await ledgerBalanced(s.product.id)
  })

  it('never returns an expired batch to sellable stock', async () => {
    const s = await sellable([[100, 5]], { price: 1 })
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 10 }])
    const [l] = await invLines(i)
    const client = await admin.connect()                                                          // test-only: batch expiry is immutable, so age it past the trigger
    try {
      await client.query('begin')
      await client.query('set local session_replication_role = replica')
      await client.query(`update public.batches set expiry_date = $2 where id = $1`, [s.batchIds[0], day(-1)])
      await client.query('commit')
    } finally {
      client.release()
    }
    const n = await draft(i, [{ type: 'RETURN', invoice_line_id: l.id, quantity: 4, condition: 'AVAILABLE' }], owner)
    const r = await failure(post(owner, n))
    expect(r.message).toMatch(/expired on .* and cannot be AVAILABLE/)
    expect((await note(n)).status).toBe('DRAFT')                                                 // all or nothing
    expect(await onHand(s.product.id)).toBe(90)
    const n2 = await draft(i, [{ type: 'RETURN', invoice_line_id: l.id, quantity: 4, condition: 'DAMAGED' }], owner)
    await ok(post(owner, n2))
  })

  it('separates drafting from posting, scopes by branch, and keeps other organizations out', async () => {
    const s = await sellable([[100, 300]], { price: 1 })
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 20 }])
    const [l] = await invLines(i)
    const lines = [{ type: 'RETURN', invoice_line_id: l.id, quantity: 5 }]
    const n = await draft(i, lines, rep)                                                          // a rep drafts
    expect((await failure(post(rep, n))).code).toBe('42501')                                      // but cannot post
    expect((await failure(save(rep2, { invoice: i, wh: wh, lines }))).code).toBe('42501')         // a branch-2 rep cannot create at branch 1's warehouse
    expect((await failure(save(accounts, { invoice: i, lines }))).code).toBe('42501')             // accounts post but do not draft
    await withUser(rep2, async (c2) => expect((await c2.q(`select count(*)::int n from public.sales_credit_notes where id = $1`, [n])).rows[0].n).toBe(0))
    await withUser(b.ownerId, async (c2) => expect((await c2.q(`select count(*)::int n from public.sales_credit_notes where id = $1`, [n])).rows[0].n).toBe(0))
    expect((await failure(post(b.ownerId, n))).code).toBe('P0002')
    await ok(post(accounts, n))                                                                    // accounts manager posts it
    // goods can come back to another warehouse - permission is checked at THAT warehouse's branch
    const s2 = await sellable([[100, 300]], { price: 1 })
    const i2 = await invoice(c, [{ product_id: s2.product.id, quantity: 20 }])
    const [l2] = await invLines(i2)
    expect((await failure(save(salesMgr, { invoice: i2, wh: wh2, lines: [{ type: 'RETURN', invoice_line_id: l2.id, quantity: 5 }] }))).code).toBe('ok')   // owner-scoped manager has it everywhere
    const branchMgr = await addUser(a.id, 'SALES_MANAGER', a.hq)
    expect((await failure(save(branchMgr, { invoice: i2, wh: wh2, lines: [{ type: 'RETURN', invoice_line_id: l2.id, quantity: 5 }] }))).code).toBe('42501')
    const back2 = await draft(i2, [{ type: 'RETURN', invoice_line_id: l2.id, quantity: 5 }], salesMgr)
    await q(`update public.sales_credit_notes set warehouse_id = $2, branch_id = $3 where id = $1`, [back2, wh2, branch2])
    await ok(post(salesMgr, back2))
    expect(Number((await q(`select coalesce(sum(quantity),0) n from public.stock_balances where product_id = $1 and warehouse_id = $2`, [s2.product.id, wh2]))[0].n)).toBe(5)
  })
})

describe('credit notes: money', () => {
  it('keeps the credit when the invoice was already paid, counts it against what the customer owes, and applies it to another invoice', async () => {
    const s = await sellable([[1000, 300]], { price: 1 })
    const c = await addCustomer({ limit: 150 })
    const paid = await invoice(c, [{ product_id: s.product.id, quantity: 100 }], 100)               // settled on the spot
    const open = await invoice(c, [{ product_id: s.product.id, quantity: 50 }])                      // 50 owed
    const [l] = await invLines(paid)
    const n = await draft(paid, [{ type: 'RETURN', invoice_line_id: l.id, quantity: 40 }])
    const r = (await ok(post(salesMgr, n))).r
    expect([num(r.applied), num(r.unapplied)]).toEqual([0, 40])                                       // paid invoice owes nothing: the 40 stays as credit
    expect(await inv(paid)).toMatchObject({ amount_paid: '100.00', amount_credited: '0.00', balance_due: '0.00' })
    const pos = (await ok(call(accounts, `select * from public.customer_credit($1)`, [c])))
    expect([num(pos.outstanding), num(pos.credit_held)]).toEqual([50, 40])
    expect(num((await ok(call(accounts, `select credit_held from public.receivables_summary() where customer_id = $1`, [c]))).credit_held)).toBe(40)
    // the statement shows invoices, the payment folded in the invoice, and the credit note as a credit
    const st = (await call(accounts, `select entry_type, reference, debit::float8 d, credit::float8 cr, balance::float8 bal from public.customer_statement($1)`, [c])) as Out
    expect(st.ok && st.rows.map((x) => x.entry_type)).toEqual(expect.arrayContaining(['INVOICE', 'CREDIT_NOTE']))
    expect(st.ok && st.rows.find((x) => x.entry_type === 'CREDIT_NOTE')).toMatchObject({ cr: 40, d: 0 })
    // apply the 40 to the open invoice (oldest due first)
    expect(num((await ok(call(accounts, `select public.apply_credit_note($1) as r`, [n]))).r.applied)).toBe(40)
    expect(await inv(open)).toMatchObject({ amount_credited: '40.00', balance_due: '10.00' })
    expect(await note(n)).toMatchObject({ applied_amount: '40.00', unapplied_amount: '0.00' })
    expect((await failure(call(accounts, `select public.apply_credit_note($1)`, [n]))).message).toMatch(/nothing left to apply/)
    expect(num((await ok(call(accounts, `select credit_held from public.customer_credit($1)`, [c]))).credit_held)).toBe(0)
  })

  it('applies credit to chosen invoices only up to what they owe, never to another customer’s invoice, and only with credit_notes.post', async () => {
    const s = await sellable([[1000, 300]], { price: 1 })
    const c = await addCustomer()
    const other = await addCustomer()
    const paid = await invoice(c, [{ product_id: s.product.id, quantity: 100 }], 100)
    const i1 = await invoice(c, [{ product_id: s.product.id, quantity: 30 }])
    const i2 = await invoice(c, [{ product_id: s.product.id, quantity: 30 }])
    const foreign = await invoice(other, [{ product_id: s.product.id, quantity: 30 }])
    const [l] = await invLines(paid)
    const n = await draft(paid, [{ type: 'RETURN', invoice_line_id: l.id, quantity: 50 }])
    await ok(post(salesMgr, n))                                                                       // 50 of credit
    expect((await failure(call(rep, `select public.apply_credit_note($1)`, [n]))).code).toBe('42501')
    expect((await failure(call(accounts, `select public.apply_credit_note($1, $2::jsonb)`, [n, JSON.stringify([{ invoice_id: foreign, amount: 10 }])]))).code).toBe('P0002')
    expect((await failure(call(accounts, `select public.apply_credit_note($1, $2::jsonb)`, [n, JSON.stringify([{ invoice_id: i1, amount: 31 }])]))).message).toMatch(/only has 30\.00 left/)
    expect((await failure(call(accounts, `select public.apply_credit_note($1, $2::jsonb)`, [n, JSON.stringify([{ invoice_id: i1, amount: 30 }, { invoice_id: i2, amount: 21 }])]))).message).toMatch(/exceed what is left/)
    await ok(call(accounts, `select public.apply_credit_note($1, $2::jsonb)`, [n, JSON.stringify([{ invoice_id: i2, amount: 30 }, { invoice_id: i1, amount: 5 }])]))
    expect([num((await inv(i1)).balance_due), num((await inv(i2)).balance_due), num((await note(n)).unapplied_amount)]).toEqual([25, 0, 15])
    expect((await failure(call(accounts, `select public.apply_credit_note($1)`, [await draft(i1, [{ type: 'PRICE', invoice_line_id: (await invLines(i1))[0].id, amount: 1 }])]))).message).toMatch(/only a posted credit note/)
  })

  it('lets a credit note go beyond nothing: a value-only PRICE correction is capped at what is left on the line and carries proportional tax', async () => {
    const s = await sellable([[1000, 300]], { price: 10, taxRate: 20 })
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 10 }])                         // 100 + 20 tax
    const [l] = await invLines(i)
    expect((await failure(save(salesMgr, { invoice: i, reason: 'PRICE_ERROR', lines: [{ type: 'PRICE', invoice_line_id: l.id, amount: 100.01 }] }))).message).toMatch(/only 100 can still be credited/)
    expect((await failure(save(salesMgr, { invoice: i, reason: 'PRICE_ERROR', lines: [{ type: 'PRICE', invoice_line_id: l.id, amount: 0.001 }] }))).code).toBe('22023')
    const n = await draft(i, [{ type: 'PRICE', invoice_line_id: l.id, amount: 25, description: 'Agreed rebate' }], salesMgr, 'PRICE_ERROR')
    expect([num((await note(n)).subtotal), num((await note(n)).tax_total), num((await note(n)).total_amount)]).toEqual([25, 5, 30])
    const r = (await ok(post(salesMgr, n))).r
    expect(r.stock_document_number).toBeNull()                                                       // no goods, no stock movement
    expect(await inv(i)).toMatchObject({ amount_credited: '30.00', balance_due: '90.00' })
    // the rest can be returned as goods, but never more than the line is still worth
    const rest = await draft(i, [{ type: 'RETURN', invoice_line_id: l.id, quantity: 10 }])
    expect([num((await note(rest)).subtotal), num((await note(rest)).tax_total)]).toEqual([75, 15])  // 100 - 25 already credited, tax 20 - 5
    await ok(post(salesMgr, rest))
    expect(await inv(i)).toMatchObject({ amount_credited: '120.00', balance_due: '0.00' })
  })

  it('does not let two drafts credit the same goods twice: the second to post is refused', async () => {
    const s = await sellable([[1000, 300]], { price: 1 })
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 100 }])
    const [l] = await invLines(i)
    const full = [{ type: 'RETURN', invoice_line_id: l.id, quantity: 100 }]
    const n1 = await draft(i, full)
    const n2 = await draft(i, full)
    const results = await Promise.all([post(salesMgr, n1), post(salesMgr, n2)])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    const lost = results.find((r) => !r.ok) as { ok: false; message: string }
    expect(lost.message).toMatch(/only 0 can still be returned/)
    expect(await onHand(s.product.id, 'QUARANTINE')).toBe(100)
    expect(await inv(i)).toMatchObject({ amount_credited: '100.00', balance_due: '0.00' })
    await ledgerBalanced(s.product.id)
  })

  it('stays consistent with receipts: a part-paid invoice credited for the rest is cleared, and voiding the payment reopens only what the credit did not cover', async () => {
    const s = await sellable([[1000, 300]], { price: 1 })
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 100 }], 60)                    // 60 paid, 40 owed
    const [l] = await invLines(i)
    const n = await draft(i, [{ type: 'RETURN', invoice_line_id: l.id, quantity: 40 }])
    expect(num((await ok(post(salesMgr, n))).r.applied)).toBe(40)
    expect(await inv(i)).toMatchObject({ amount_paid: '60.00', amount_credited: '40.00', balance_due: '0.00' })
    const rcp = (await q(`select r.id from public.customer_receipts r where r.customer_id = $1`, [c]))[0].id
    await ok(call(accounts, `select public.void_receipt($1, 'Bounced')`, [rcp]))
    expect(await inv(i)).toMatchObject({ amount_paid: '0.00', amount_credited: '40.00', balance_due: '60.00' })
    // the database refuses a state where paid + credited exceed the invoice
    await expect(admin.query(`update public.sales_invoices set amount_credited = 101 where id = $1`, [i])).rejects.toMatchObject({ code: '23514' })
  })
})

describe('credit notes: life cycle and immutability', () => {
  it('cancels a draft with a reason, refuses to edit or post it afterwards, and never cancels a posted one', async () => {
    const s = await sellable([[100, 300]], { price: 1 })
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 20 }])
    const [l] = await invLines(i)
    const lines = [{ type: 'RETURN', invoice_line_id: l.id, quantity: 5 }]
    const n = await draft(i, lines)
    expect((await failure(call(salesMgr, `select public.cancel_credit_note($1, '')`, [n]))).code).toBe('22023')
    expect((await failure(call(accounts, `select public.cancel_credit_note($1, 'x')`, [n]))).code).toBe('42501')
    await ok(call(salesMgr, `select public.cancel_credit_note($1, 'Customer changed their mind')`, [n]))
    expect(await note(n)).toMatchObject({ status: 'CANCELLED', status_reason: 'Customer changed their mind' })
    expect((await failure(save(salesMgr, { id: n, invoice: i, lines }))).message).toMatch(/only a draft/)
    expect((await failure(post(salesMgr, n))).message).toMatch(/only a draft/)
    const done = await draft(i, lines)
    await ok(post(salesMgr, done))
    expect((await failure(call(salesMgr, `select public.cancel_credit_note($1, 'oops')`, [done]))).message).toMatch(/only a draft/)
    expect((await failure(post(salesMgr, done))).message).toMatch(/only a draft/)
  })

  it('edits a draft in place (lines replaced, same invoice) and posted records can never be changed or deleted', async () => {
    const s = await sellable([[100, 300]], { price: 2 })
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 20 }])
    const [l] = await invLines(i)
    const n = await draft(i, [{ type: 'RETURN', invoice_line_id: l.id, quantity: 5 }])
    await ok(save(salesMgr, { id: n, invoice: i, lines: [{ type: 'RETURN', invoice_line_id: l.id, quantity: 8 }], reason: 'WRONG_ITEM' }))
    expect(await note(n)).toMatchObject({ reason_code: 'WRONG_ITEM', total_amount: '16.00' })
    expect(await q(`select count(*)::int n from public.sales_credit_note_lines where credit_note_id = $1`, [n])).toEqual([{ n: 1 }])
    const other = await invoice(c, [{ product_id: s.product.id, quantity: 1 }])
    expect((await failure(save(salesMgr, { id: n, invoice: other, lines: [{ type: 'RETURN', invoice_line_id: (await invLines(other))[0].id, quantity: 1 }] }))).message).toMatch(/cannot be moved/)
    await ok(post(salesMgr, n))
    // nobody - not even the table owner - can alter what was posted
    for (const sql of [
      `update public.sales_credit_notes set total_amount = 1, subtotal = 1, tax_total = 0 where id = $1`,
      `update public.sales_credit_notes set status = 'CANCELLED' where id = $1`,
      `update public.sales_credit_notes set credit_note_number = 'X' where id = $1`,
      `delete from public.sales_credit_notes where id = $1`,
      `update public.sales_credit_note_lines set quantity = 1 where credit_note_id = $1`,
      `delete from public.sales_credit_note_lines where credit_note_id = $1`,
      `update public.sales_credit_note_returns set base_quantity = 1 where credit_note_id = $1`,
      `delete from public.sales_credit_note_returns where credit_note_id = $1`,
      `update public.credit_note_allocations set amount = 1 where credit_note_id = $1`,
      `delete from public.credit_note_allocations where credit_note_id = $1`,
    ]) await expect(admin.query(sql, [n]), sql).rejects.toBeTruthy()
    // signed-in users cannot write the tables at all
    for (const user of [owner, salesMgr]) {
      expect(await code(call(user, `update public.sales_credit_notes set total_amount = 1 where id = $1`, [n]))).toBe('42501')
      expect(await code(call(user, `insert into public.sales_credit_notes (sales_invoice_id, customer_id, branch_id, warehouse_id, credit_date, reason_code, currency_code) values ($1, $2, $3, $4, current_date, 'OTHER', 'GHS')`, [i, c, a.hq, wh]))).toBe('42501')
      expect(await code(call(user, `delete from public.credit_note_allocations`))).toBe('42501')
    }
    // the audit trail records the posting
    expect((await q(`select count(*)::int n from public.audit_logs where entity_type = 'sales_credit_note' and entity_id = $1`, [n]))[0].n).toBeGreaterThanOrEqual(2)
  })

  it('shows what can still be credited on each invoice line', async () => {
    const s = await sellable([[100, 300]], { price: 2 })
    const c = await addCustomer()
    const i = await invoice(c, [{ product_id: s.product.id, quantity: 20 }])
    const [l] = await invLines(i)
    await ok(post(salesMgr, await draft(i, [{ type: 'RETURN', invoice_line_id: l.id, quantity: 6 }])))
    const rows = (await call(salesMgr, `select quantity::float8 q, returned_quantity::float8 r, remaining_quantity::float8 rem, line_net::float8 net, credited_net::float8 cn, remaining_net::float8 rn from public.invoice_creditable($1)`, [i])) as Out
    expect(rows.ok && rows.rows).toEqual([{ q: 20, r: 6, rem: 14, net: 40, cn: 12, rn: 28 }])
    const hidden = (await call(await addUser(b.id, 'SALES_MANAGER'), `select count(*)::int n from public.invoice_creditable($1)`, [i])) as Out
    expect(hidden.ok && hidden.rows[0].n).toBe(0)
  })
})
