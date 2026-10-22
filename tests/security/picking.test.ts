import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBranch, addLocation, addProduct, addUser, addWarehouse, admin, closePool, createOrg, rand, withUser, type Org } from '../helpers/db'

let a: Org
let b: Org
let wh: string
let branch2: string
let owner: string
let ownerB: string
let picker: string       // fulfilment.view + picking.work, whole organization
let picker2: string      // WAREHOUSE_PICKER limited to branch 2
let packer: string       // fulfilment.view only
let whMgr: string        // everything but cannot... (release, assign, work)
let dispatcher: string   // view + release
let auditor: string      // view only
let cashier: string      // nothing
let defaultList: string

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

type Out = { ok: true; rows: any[]; rowCount: number } | { ok: false; code: string; message: string }
const call = (user: string, sql: string, params: unknown[] = []): Promise<Out> => withUser(user, (c) => c.attempt(sql, params), { commit: true }) as Promise<Out>
const ok = async (p: Promise<Out>) => { const r = await p; if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`); return r.rows }
const failure = async (p: Promise<Out>) => { const r = await p; return r.ok ? { code: 'ok', message: '' } : { code: r.code, message: r.message } }
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows

beforeAll(async () => {
  a = await createOrg('PICK-A')
  b = await createOrg('PICK-B')
  wh = await addWarehouse(a.id, a.hq, 'W1')
  branch2 = await addBranch(a.id, 'B2')
  await addWarehouse(a.id, branch2, 'W2')
  owner = a.ownerId
  ownerB = b.ownerId
  picker = await addUser(a.id, 'WAREHOUSE_PICKER')
  picker2 = await addUser(a.id, 'WAREHOUSE_PICKER', branch2)
  packer = await addUser(a.id, 'WAREHOUSE_PACKER')
  whMgr = await addUser(a.id, 'WAREHOUSE_MANAGER')
  dispatcher = await addUser(a.id, 'DISPATCHER')
  auditor = await addUser(a.id, 'AUDITOR')
  cashier = await addUser(a.id, 'CASHIER')
  defaultList = (await q(`insert into public.price_lists (organization_id, code, name, is_default) values ($1, 'RETAIL', 'Retail', true) returning id`, [a.id]))[0].id
})
afterAll(closePool)

async function addCustomer(): Promise<string> {
  return (await q(
    `insert into public.customers (organization_id, code, name, customer_type, licence_number, licence_expiry, payment_terms_days, credit_limit, address)
     values ($1, $2, $3, 'PHARMACY', 'PC/1', $4, 30, 1000000, 'Plot 4, Spintex Road') returning id`, [a.id, `C${rand()}`, `Customer ${rand()}`, day(300)]))[0].id
}
async function stocked(location?: string) {
  const product = await addProduct(a.id, { cls: 'GSL' })
  await q(`insert into public.price_list_items (organization_id, price_list_id, product_id, product_unit_id, unit_price) values ($1, $2, $3, $4, 10)`, [a.id, defaultList, product.id, product.baseUnitRowId])
  const batch = `B${rand()}`
  await ok(call(owner, `select public.post_stock_document('OPENING', $1, $2::jsonb) as r`, [wh, JSON.stringify([{
    product_id: product.id, quantity: 1000, batch_number: batch, expiry_date: day(300), unit_cost: 4, ...(location ? { location_id: location } : {}) }])]))
  return { ...product, batch }
}
async function invoice(lines: { product: string; qty: number }[], post = true): Promise<string> {
  const customer = await addCustomer()
  const id = (await ok(call(owner, `select public.save_sales_invoice(null, $1, $2, null, null, $3::jsonb) as id`, [customer, wh, JSON.stringify(lines.map((l) => ({ product_id: l.product, quantity: l.qty })))])))[0].id
  if (post) await ok(call(owner, `select public.post_sales_invoice($1) as r`, [id]))
  return id
}
const release = (user: string, invoiceId: string, priority = 2) => call(user, `select public.release_to_warehouse($1, $2::smallint) as id`, [invoiceId, priority])
const order = async (id: string) => (await q(`select * from public.fulfilment_orders where id = $1`, [id]))[0]
const lines = async (id: string) => q(`select * from public.pick_lines where fulfilment_order_id = $1 order by line_no`, [id])
const movements = async () => (await q(`select count(*)::int n from public.stock_movements where organization_id = $1`, [a.id]))[0].n as number

/** a released order with two lines on different shelves: the second line in walking order is `far` */
async function released() {
  const l1 = await addLocation(a.id, wh, `A-${rand()}`)
  const l2 = await addLocation(a.id, wh, `B-${rand()}`)
  await q(`update public.warehouse_locations set picking_sequence = 10 where id = $1`, [l1])
  await q(`update public.warehouse_locations set picking_sequence = 20 where id = $1`, [l2])
  const far = await stocked(l2)
  const near = await stocked(l1)
  const inv = await invoice([{ product: far.id, qty: 5 }, { product: near.id, qty: 7 }])
  const id = (await ok(release(owner, inv)))[0].id as string
  return { id, inv, far, near }
}

describe('picking permissions', () => {
  it('gives the picking rights to the intended roles only', async () => {
    const rows = await q(`select r.code as role, p.code as perm from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id
      where p.code in ('fulfilment.view','fulfilment.release','picking.work','picking.assign') and r.organization_id is null`)
    const has = (role: string, perm: string) => rows.some((r) => r.role === role && r.perm === perm)
    for (const r of ['SUPER_ADMIN', 'OWNER', 'GENERAL_MANAGER', 'BRANCH_MANAGER', 'WAREHOUSE_MANAGER']) for (const p of ['fulfilment.view', 'fulfilment.release', 'picking.work', 'picking.assign']) expect(has(r, p), `${r} ${p}`).toBe(true)
    expect([has('WAREHOUSE_PICKER', 'fulfilment.view'), has('WAREHOUSE_PICKER', 'picking.work'), has('WAREHOUSE_PICKER', 'picking.assign'), has('WAREHOUSE_PICKER', 'fulfilment.release')]).toEqual([true, true, false, false])
    expect([has('WAREHOUSE_PACKER', 'fulfilment.view'), has('WAREHOUSE_PACKER', 'picking.work')]).toEqual([true, false])
    expect([has('DISPATCHER', 'fulfilment.view'), has('DISPATCHER', 'fulfilment.release'), has('DISPATCHER', 'picking.work')]).toEqual([true, true, false])
    expect([has('AUDITOR', 'fulfilment.view'), has('AUDITOR', 'fulfilment.release'), has('AUDITOR', 'picking.work')]).toEqual([true, false, false])
    expect(rows.filter((r) => r.role === 'CASHIER')).toEqual([])
    // the sales team that raises the invoices may release them
    expect([has('SALES_MANAGER', 'fulfilment.release'), has('SALES_REP', 'fulfilment.release'), has('SALES_REP', 'picking.work')]).toEqual([true, true, false])
  })

  it('has no direct write access to any picking table', async () => {
    const rows = await q(`select table_name, privilege_type from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'public'
      and table_name in ('fulfilment_orders', 'pick_lines', 'fulfilment_exceptions') and privilege_type <> 'SELECT'`)
    expect(rows).toEqual([])
  })
})

describe('release to the warehouse', () => {
  it('creates an order with one pick line per allocation, in walking order, and changes no stock', async () => {
    const before = await movements()
    const { id, inv, far, near } = await released()
    const afterRelease = await movements()
    expect(afterRelease).toBe(before + 4)                                                        // the two opening documents and the two sales of this test setup
    const o = await order(id)
    expect(o).toMatchObject({ status: 'RELEASED', branch_id: a.hq, warehouse_id: wh, sales_invoice_id: inv, priority: 2, picker_id: null })
    expect(o.order_number).toMatch(/^FO-\d{4}-\d{6}$/)
    const ls = await lines(id)
    expect(ls.map((l) => [l.line_no, l.product_id, Number(l.expected_quantity), l.status])).toEqual([[1, near.id, 7, 'PENDING'], [2, far.id, 5, 'PENDING']])
    const pick = await ok(call(picker, `select line_no, sku, expected_quantity::float8 eq, batch_number, location_code, picking_sequence, status from public.fulfilment_pick_list($1)`, [id]))
    expect(pick.map((r) => [r.sku, r.eq, r.picking_sequence, r.status])).toEqual([[near.sku, 7, 10, 'PENDING'], [far.sku, 5, 20, 'PENDING']])
    expect(pick[0].batch_number).toBe(near.batch)
    expect(await movements()).toBe(afterRelease)
  })

  it('refuses a draft invoice, a second release, bad priorities, and people without the right', async () => {
    const p = await stocked()
    const draft = await invoice([{ product: p.id, qty: 1 }], false)
    expect((await failure(release(owner, draft))).message).toMatch(/only a posted invoice/)
    const posted = await invoice([{ product: p.id, qty: 1 }])
    expect((await failure(release(picker, posted))).code).toBe('42501')
    expect((await failure(release(cashier, posted))).code).toBe('42501')
    expect((await failure(release(owner, posted, 9))).code).toBe('22023')
    const id = (await ok(release(dispatcher, posted, 1)))[0].id
    expect((await order(id)).priority).toBe(1)
    expect((await failure(release(owner, posted))).message).toMatch(/already been released/)
    expect((await failure(release(owner, '00000000-0000-0000-0000-000000000000'))).code).toBe('P0002')
  })
})

describe('picking an order', () => {
  it('claim, confirm every line in full, order becomes PICKED, and stock is untouched', async () => {
    const { id } = await released()
    const before = await movements()
    const ls = await lines(id)
    // cannot pick before claiming
    expect((await failure(call(picker, `select public.confirm_pick_line($1, 7)`, [ls[0].id]))).message).toMatch(/claim it before picking/)
    await ok(call(picker, `select public.claim_fulfilment_order($1)`, [id]))
    expect(await order(id)).toMatchObject({ status: 'PICKING', picker_id: picker })
    expect((await order(id)).picking_started_at).not.toBeNull()
    const r1 = (await ok(call(picker, `select public.confirm_pick_line($1, 7) as r`, [ls[0].id])))[0].r
    expect(r1).toMatchObject({ order_status: 'PICKING', pending: 1 })
    const r2 = (await ok(call(picker, `select public.confirm_pick_line($1, 5) as r`, [ls[1].id])))[0].r
    expect(r2).toMatchObject({ order_status: 'PICKED', pending: 0 })
    expect(await order(id)).toMatchObject({ status: 'PICKED' })
    expect((await order(id)).picked_at).not.toBeNull()
    expect((await lines(id)).map((l) => [l.status, l.picked_by])).toEqual([['PICKED', picker], ['PICKED', picker]])
    expect(await movements()).toBe(before)
    expect((await failure(call(picker, `select public.confirm_pick_line($1, 7)`, [ls[0].id]))).message).toMatch(/is PICKED|already been confirmed/)
  })

  it('checks quantity, batch and barcode', async () => {
    const { id, near } = await released()
    const ls = await lines(id)
    await ok(call(picker, `select public.claim_fulfilment_order($1)`, [id]))
    expect((await failure(call(picker, `select public.confirm_pick_line($1, 8)`, [ls[0].id]))).code).toBe('22023')
    expect((await failure(call(picker, `select public.confirm_pick_line($1, -1)`, [ls[0].id]))).code).toBe('22023')
    expect((await failure(call(picker, `select public.confirm_pick_line($1, 7, null, null, 'WRONG-BATCH')`, [ls[0].id]))).message).toMatch(/wrong batch/)
    expect((await failure(call(picker, `select public.confirm_pick_line($1, 7, null, null, null, '999999999')`, [ls[0].id]))).message).toMatch(/barcode does not belong/)
    await q(`insert into public.product_barcodes (organization_id, product_id, product_unit_id, barcode, barcode_type) values ($1, $2, $3, $4, 'INTERNAL')`, [a.id, near.id, near.baseUnitRowId, `INT${rand()}`])
    const bc = (await q(`select barcode from public.product_barcodes where product_id = $1`, [near.id]))[0].barcode
    await ok(call(picker, `select public.confirm_pick_line($1, 7, null, null, $2, $3)`, [ls[0].id, near.batch.toLowerCase(), bc]))     // batch compare ignores case
    expect((await lines(id))[0].status).toBe('PICKED')
  })

  it('a short pick needs a reason, opens an exception, and keeps the order in PICKING until a supervisor resolves it', async () => {
    const { id } = await released()
    const ls = await lines(id)
    await ok(call(picker, `select public.claim_fulfilment_order($1)`, [id]))
    expect((await failure(call(picker, `select public.confirm_pick_line($1, 3)`, [ls[0].id]))).message).toMatch(/needs a reason/)
    expect((await failure(call(picker, `select public.confirm_pick_line($1, 3, 'OTHER')`, [ls[0].id]))).message).toMatch(/explain/)
    expect((await failure(call(picker, `select public.confirm_pick_line($1, 3, 'MADE_UP')`, [ls[0].id]))).code).toBe('22023')
    await ok(call(picker, `select public.confirm_pick_line($1, 3, 'DAMAGED', 'Two blisters crushed')`, [ls[0].id]))
    const r = (await ok(call(picker, `select public.confirm_pick_line($1, 5) as r`, [ls[1].id])))[0].r
    expect(r.order_status).toBe('PICKING')                                                        // every line confirmed, but a short pick is waiting
    const line = (await lines(id))[0]
    expect(line).toMatchObject({ status: 'SHORT', short_reason: 'DAMAGED', short_note: 'Two blisters crushed' })
    expect(Number(line.picked_quantity)).toBe(3)
    const ex = (await q(`select * from public.fulfilment_exceptions where fulfilment_order_id = $1`, [id]))[0]
    expect(ex).toMatchObject({ status: 'OPEN', kind: 'SHORT', reason: 'DAMAGED', pick_line_id: line.id })
    expect(Number(ex.short_quantity)).toBe(4)
    // only a supervisor resolves it
    expect((await failure(call(picker, `select public.resolve_short_pick($1, 'fine')`, [ex.id]))).code).toBe('42501')
    expect((await failure(call(whMgr, `select public.resolve_short_pick($1, '')`, [ex.id]))).code).toBe('22023')
    expect((await ok(call(whMgr, `select public.resolve_short_pick($1, 'Customer agreed to 3 packs; credit note to follow') as s`, [ex.id])))[0].s).toBe('PICKED')
    expect(await order(id)).toMatchObject({ status: 'PICKED' })
    expect((await q(`select status, decision, resolved_by from public.fulfilment_exceptions where id = $1`, [ex.id]))[0]).toMatchObject({ status: 'RESOLVED', decision: 'ACCEPT_SHORT', resolved_by: whMgr })
    expect((await failure(call(whMgr, `select public.resolve_short_pick($1, 'again')`, [ex.id]))).message).toMatch(/already been resolved/)
    expect((await failure(call(whMgr, `select public.reset_pick_line($1, 'oops')`, [line.id]))).message).toMatch(/already resolved/)
  })

  it('a supervisor can reset a wrong confirmation, which withdraws its open exception and reopens a PICKED order', async () => {
    const { id } = await released()
    const ls = await lines(id)
    await ok(call(picker, `select public.claim_fulfilment_order($1)`, [id]))
    await ok(call(picker, `select public.confirm_pick_line($1, 2, 'NOT_FOUND')`, [ls[0].id]))
    await ok(call(picker, `select public.confirm_pick_line($1, 5)`, [ls[1].id]))
    expect((await failure(call(picker, `select public.reset_pick_line($1, 'my mistake')`, [ls[0].id]))).code).toBe('42501')
    expect((await failure(call(whMgr, `select public.reset_pick_line($1, '')`, [ls[0].id]))).code).toBe('22023')
    await ok(call(whMgr, `select public.reset_pick_line($1, 'Counted wrongly, more on the shelf')`, [ls[0].id]))
    expect((await lines(id))[0]).toMatchObject({ status: 'PENDING', picked_quantity: null, picked_by: null, short_reason: null })
    expect((await q(`select status, decision from public.fulfilment_exceptions where fulfilment_order_id = $1`, [id]))[0]).toMatchObject({ status: 'RESOLVED', decision: 'WITHDRAWN' })
    expect((await failure(call(whMgr, `select public.reset_pick_line($1, 'again')`, [ls[0].id]))).message).toMatch(/not been confirmed/)
    const r = (await ok(call(picker, `select public.confirm_pick_line($1, 7) as r`, [ls[0].id])))[0].r
    expect(r.order_status).toBe('PICKED')
    // resetting a line of a PICKED order reopens it
    await ok(call(whMgr, `select public.reset_pick_line($1, 'Wrong batch scanned')`, [ls[1].id]))
    expect((await order(id)).status).toBe('PICKING')
    expect((await order(id)).picked_at).toBeNull()
    const audit = await q(`select reason from public.audit_logs where action = 'pick_line.reset' and entity_id = $1`, [ls[1].id])
    expect(audit.map((x) => x.reason)).toEqual(['Wrong batch scanned'])
  })

  it('one picker at a time; a supervisor can assign, work on behalf, and the assignee must be able to pick at that branch', async () => {
    const { id } = await released()
    const ls = await lines(id)
    await ok(call(picker, `select public.claim_fulfilment_order($1)`, [id]))
    expect((await failure(call(whMgr, `select public.claim_fulfilment_order($1)`, [id]))).message).toMatch(/someone else/)
    expect((await failure(call(packer, `select public.claim_fulfilment_order($1)`, [id]))).code).toBe('42501')
    expect((await failure(call(picker2, `select public.claim_fulfilment_order($1)`, [id]))).code).toBe('P0002')   // a branch-2 picker cannot even see a head-office order
    expect((await failure(call(picker, `select public.assign_picker($1, $2)`, [id, whMgr]))).code).toBe('42501')   // pickers do not assign
    expect((await failure(call(whMgr, `select public.assign_picker($1, $2)`, [id, packer]))).message).toMatch(/cannot pick for this branch/)
    expect((await failure(call(whMgr, `select public.assign_picker($1, $2)`, [id, picker2]))).message).toMatch(/cannot pick for this branch/)
    expect((await failure(call(whMgr, `select public.assign_picker($1, $2)`, [id, ownerB]))).message).toMatch(/cannot pick for this branch/)  // another organization's person
    await ok(call(whMgr, `select public.assign_picker($1, $2)`, [id, whMgr]))
    expect((await order(id)).picker_id).toBe(whMgr)
    expect((await failure(call(picker, `select public.confirm_pick_line($1, 7)`, [ls[0].id]))).message).toMatch(/assigned to someone else/)
    await ok(call(owner, `select public.confirm_pick_line($1, 7)`, [ls[0].id]))                                    // a supervisor may work on behalf
    await ok(call(whMgr, `select public.release_fulfilment_claim($1)`, [id]))
    expect(await order(id)).toMatchObject({ picker_id: null, status: 'PICKING' })                                  // work has started, so it stays PICKING
    await ok(call(picker, `select public.claim_fulfilment_order($1)`, [id]))
    expect((await order(id)).picker_id).toBe(picker)
  })

  it('options for assignment list only people who can pick at the branch, and only for supervisors', async () => {
    const names = await ok(call(whMgr, `select id from public.picker_options($1)`, [a.hq]))
    const ids = names.map((r) => r.id)
    expect(ids).toContain(picker)
    expect(ids).not.toContain(packer)
    expect(ids).not.toContain(picker2)
    expect((await ok(call(picker, `select id from public.picker_options($1)`, [a.hq]))).length).toBe(0)
  })
})

describe('cancelling and reversal', () => {
  it('cancels an unpacked order with a reason, can be released again, and a reversed invoice cancels its order by itself', async () => {
    const { id, inv } = await released()
    expect((await failure(call(picker, `select public.cancel_fulfilment_order($1, 'no longer needed')`, [id]))).code).toBe('42501')
    expect((await failure(call(owner, `select public.cancel_fulfilment_order($1, '')`, [id]))).code).toBe('22023')
    await ok(call(owner, `select public.cancel_fulfilment_order($1, 'Customer will collect')`, [id]))
    expect(await order(id)).toMatchObject({ status: 'CANCELLED', cancel_reason: 'Customer will collect', picker_id: null })
    expect((await failure(call(owner, `select public.claim_fulfilment_order($1)`, [id]))).code).toBe('22023')
    const again = (await ok(release(owner, inv)))[0].id as string
    expect(again).not.toBe(id)
    expect((await order(again)).status).toBe('RELEASED')
    await ok(call(owner, `select public.reverse_sales_invoice($1, 'Sale cancelled by the customer')`, [inv]))
    expect(await order(again)).toMatchObject({ status: 'CANCELLED', cancel_reason: 'The invoice was reversed' })
  })
})

describe('integrity of the records', () => {
  it('pick lines keep what was allocated: product, batch, location and expected quantity never change, and nothing is deleted', async () => {
    const { id } = await released()
    const l = (await lines(id))[0]
    for (const sql of [
      `update public.pick_lines set expected_quantity = 1 where id = $1`, `update public.pick_lines set batch_id = null where id = $1`, `update public.pick_lines set location_id = null where id = $1`,
      `delete from public.pick_lines where id = $1`, `delete from public.fulfilment_orders where id = '${id}'`, `update public.fulfilment_orders set sales_invoice_id = sales_invoice_id, branch_id = '${branch2}' where id = '${id}'`,
    ]) await expect(admin.query(sql, [l.id]), sql).rejects.toBeTruthy()
    // a line cannot claim more than was allocated, or a short without a reason, even for the server role
    await expect(admin.query(`update public.pick_lines set status = 'PICKED', picked_quantity = 99, picked_by = $2, picked_at = now() where id = $1`, [l.id, picker])).rejects.toBeTruthy()
    await expect(admin.query(`update public.pick_lines set status = 'SHORT', picked_quantity = 1, picked_by = $2, picked_at = now() where id = $1`, [l.id, picker])).rejects.toBeTruthy()
  })

  it('records every step in the audit log', async () => {
    const { id } = await released()
    const ls = await lines(id)
    await ok(call(picker, `select public.claim_fulfilment_order($1)`, [id]))
    await ok(call(picker, `select public.confirm_pick_line($1, 7)`, [ls[0].id]))
    const actions = (await q(`select action from public.audit_logs where entity_type = 'fulfilment_order' and entity_id = $1 order by created_at`, [id])).map((r) => r.action)
    expect(actions).toEqual(['fulfilment_order.created', 'fulfilment_order.updated'])
    expect((await q(`select count(*)::int n from public.audit_logs where entity_type = 'pick_line' and entity_id = $1 and action = 'pick_line.updated'`, [ls[0].id]))[0].n).toBe(1)
  })
})

describe('branch scope and tenants', () => {
  it('a branch picker sees only their branch; reading follows the view right', async () => {
    const { id } = await released()
    const seen = (u: string) => withUser(u, async (c) => (await c.q(`select id from public.fulfilment_orders`)).rows.map((r) => r.id as string))
    expect(await seen(picker)).toContain(id)
    expect(await seen(auditor)).toContain(id)
    expect(await seen(picker2)).not.toContain(id)
    expect(await seen(cashier)).toEqual([])
    expect((await ok(call(picker2, `select id from public.fulfilment_queue()`))).length).toBe(0)
    expect((await ok(call(cashier, `select id from public.fulfilment_queue()`))).length).toBe(0)
    expect((await failure(call(picker2, `select * from public.fulfilment_pick_list($1)`, [id]))).code).toBe('P0002')
    const queue = await ok(call(picker, `select id, status, line_count, lines_done, open_exceptions, invoice_number, customer_name from public.fulfilment_queue('RELEASED')`))
    expect(queue.find((r) => r.id === id)).toMatchObject({ status: 'RELEASED', line_count: 2, lines_done: 0, open_exceptions: 0 })
    const mine = await ok(call(picker, `select id from public.fulfilment_queue(null, true)`))
    expect(mine.map((r) => r.id)).not.toContain(id)
  })

  it('another organization sees nothing, and every function treats its ids as not found', async () => {
    const { id, inv } = await released()
    const ls = await lines(id)
    const seen = await withUser(ownerB, async (c) => ({
      o: (await c.q(`select count(*)::int n from public.fulfilment_orders where organization_id <> $1`, [b.id])).rows[0].n,
      l: (await c.q(`select count(*)::int n from public.pick_lines where organization_id <> $1`, [b.id])).rows[0].n,
      e: (await c.q(`select count(*)::int n from public.fulfilment_exceptions where organization_id <> $1`, [b.id])).rows[0].n,
    }))
    expect(seen).toEqual({ o: 0, l: 0, e: 0 })
    expect((await ok(call(ownerB, `select id from public.fulfilment_queue()`))).length).toBe(0)
    for (const [sql, params] of [
      [`select public.release_to_warehouse($1)`, [inv]], [`select public.claim_fulfilment_order($1)`, [id]], [`select public.release_fulfilment_claim($1)`, [id]],
      [`select public.assign_picker($1, null)`, [id]], [`select public.confirm_pick_line($1, 1)`, [ls[0].id]], [`select public.reset_pick_line($1, 'abc')`, [ls[0].id]],
      [`select public.cancel_fulfilment_order($1, 'abc')`, [id]], [`select * from public.fulfilment_pick_list($1)`, [id]],
    ] as [string, unknown[]][]) expect((await failure(call(ownerB, sql, params))).code, sql).toBe('P0002')
    expect((await ok(call(ownerB, `select id from public.picker_options($1)`, [a.hq]))).length).toBe(0)
    const upd = await call(ownerB, `update public.fulfilment_orders set priority = 1 where organization_id = $1`, [a.id])
    expect(upd.ok).toBe(false)                                                                       // no write grants at all
    expect((await withUser(null, (c) => c.attempt(`select * from public.fulfilment_orders`)) as Out).ok).toBe(false)
  })
})
