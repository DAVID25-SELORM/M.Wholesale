import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addLocation, addProduct, addSupplier, addUser, addWarehouse, admin, closePool, createOrg, rand, withUser, type Org } from '../helpers/db'

// A rehearsal of docs/PILOT_ACCEPTANCE.md with synthetic data, performed by the job roles a business would
// actually assign (not the owner, except where only a senior role can act, which is recorded as a finding).
// Evidence (document numbers, expected and actual values) is written to PILOT_EVIDENCE when set.

let org: Org
let rival: Org
let wh: string
let bin: string
let priceList: string
const people: Record<string, string> = {}
const evidence: Record<string, Record<string, unknown>> = {}
const note = (scenario: string, key: string, value: unknown) => { (evidence[scenario] ??= {})[key] = value }
const day = (n = 0) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows
const run = (who: string, sql: string, params: unknown[] = []) => withUser(people[who] ?? who, (c) => c.attempt(sql, params), { commit: true })
async function ok(who: string, sql: string, params: unknown[] = []) {
  const r = await run(who, sql, params)
  if (!r.ok) throw new Error(`${who}: ${r.code} ${r.message}\n${sql}`)
  return r.rows
}
const one = async (who: string, sql: string, params: unknown[] = []) => (await ok(who, sql, params))[0]
const refused = async (who: string, sql: string, params: unknown[] = []) => { const r = await run(who, sql, params); return r.ok ? 'ALLOWED' : `${r.code}: ${r.message}` }
const money = (v: unknown) => Math.round(Number(v) * 100) / 100
const J = JSON.stringify

async function product(cls = 'GSL', price = 10) {
  const p = await addProduct(org.id, { cls })
  await q(`insert into public.price_list_items(organization_id,price_list_id,product_id,product_unit_id,unit_price) values($1,$2,$3,$4,$5)`, [org.id, priceList, p.id, p.baseUnitRowId, price])
  return p
}
const stock = (productId: string, quantity: number, batch = `LOT-${rand()}`, expiry = day(500), location: string | null = bin) =>
  ok('warehouse', `select public.post_stock_document('OPENING',$1,$2::jsonb)`, [wh, J([{ product_id: productId, quantity, batch_number: batch, expiry_date: expiry, unit_cost: 4, ...(location ? { location_id: location } : {}) }])])
async function customer(extra: { controlled?: boolean } = {}) {
  const id = (await q(`insert into public.customers(organization_id,code,name,customer_type,licence_number,licence_expiry,payment_terms_days,credit_limit,address,contact_name,phone) values($1,$2,$3,'PHARMACY','PC/TEST',$4,30,100000,'Synthetic address','Test contact','000') returning id`, [org.id, `C${rand()}`, `Pilot Pharmacy ${rand()}`, day(300)]))[0].id
  if (extra.controlled) await q('update public.customers set controlled_drugs_authorised=true where id=$1', [id])
  return id as string
}
async function sell(who: string, customerId: string, productId: string, quantity: number) {
  const id = (await one('sales_rep', `select public.save_sales_invoice(null,$1,$2,null,null,$3::jsonb) id`, [customerId, wh, J([{ product_id: productId, quantity }])])).id
  await ok(who, 'select public.post_sales_invoice($1)', [id])
  return (await q('select * from public.sales_invoices where id=$1', [id]))[0]
}
const journalsBalance = async () => (await q(`select coalesce(sum(l.debit),0) d, coalesce(sum(l.credit),0) c from public.gl_journal_lines l where l.organization_id=$1`, [org.id]))[0]

beforeAll(async () => {
  org = await createOrg('PILOT')
  rival = await createOrg('PILOT-RIVAL')
  wh = await addWarehouse(org.id, org.hq, 'MAIN')
  bin = await addLocation(org.id, wh, 'A-01')
  priceList = (await q(`insert into public.price_lists(organization_id,code,name,is_default) values($1,'RETAIL','Retail',true) returning id`, [org.id]))[0].id
  const roles: Record<string, string> = {
    gm: 'GENERAL_MANAGER', procurement_mgr: 'PROCUREMENT_MANAGER', procurement: 'PROCUREMENT_OFFICER', warehouse: 'WAREHOUSE_MANAGER', picker: 'WAREHOUSE_PICKER', packer: 'WAREHOUSE_PACKER',
    pharmacist: 'PHARMACIST', sales_rep: 'SALES_REP', sales_mgr: 'SALES_MANAGER', cashier: 'CASHIER', accounts_mgr: 'ACCOUNTS_MANAGER', accounts_mgr2: 'ACCOUNTS_MANAGER', accounts: 'ACCOUNTS_OFFICER', dispatcher: 'DISPATCHER', auditor: 'AUDITOR',
  }
  for (const [name, role] of Object.entries(roles)) people[name] = await addUser(org.id, role)
  people.owner = org.ownerId
  await ok('owner', `select public.start_accounting(current_date,'[]'::jsonb)`)
})
afterAll(async () => {
  if (process.env.PILOT_EVIDENCE) writeFileSync(process.env.PILOT_EVIDENCE, JSON.stringify(evidence, null, 2))
  await closePool()
})

describe('pilot rehearsal', () => {
  it('1. purchase request to receipt, invoice and payment', async () => {
    const s = '1'
    const p = await product('GSL', 20)
    const supplier = await addSupplier(org.id)
    const request = (await one('warehouse', 'select public.create_purchase_request($1,$2,null,$3,$4::jsonb) id', [org.hq, wh, 'Pilot restock', J([{ product_id: p.id, quantity: 40 }])])).id
    await ok('warehouse', 'select public.submit_purchase_request($1)', [request])
    note(s, 'requester approving own request', await refused('warehouse', 'select public.decide_purchase_request($1,true,$2)', [request, 'Self approval attempt']))
    note(s, 'procurement manager approving the request', await refused('procurement_mgr', 'select public.decide_purchase_request($1,true,$2)', [request, 'Approved for pilot']))
    if (evidence[s]!['procurement manager approving the request'] !== 'ALLOWED') await ok('gm', 'select public.decide_purchase_request($1,true,$2)', [request, 'Approved for pilot'])
    // self-approval, tried by someone who DOES hold the approval right
    const own = (await one('gm', 'select public.create_purchase_request($1,$2,null,$3,$4::jsonb) id', [org.hq, wh, 'GM request', J([{ product_id: p.id, quantity: 1 }])])).id
    await ok('gm', 'select public.submit_purchase_request($1)', [own])
    note(s, 'senior approving own request', await refused('gm', 'select public.decide_purchase_request($1,true,$2)', [own, 'Approving my own request']))
    expect(evidence[s]!['senior approving own request']).not.toBe('ALLOWED')
    const costs = J({ [p.id]: 12.5 })
    let po: string | null = null
    for (const who of ['procurement', 'procurement_mgr', 'warehouse', 'gm']) {
      const r = await run(who, 'select public.convert_purchase_request($1,$2,$3,$4::jsonb) id', [request, supplier, wh, costs])
      note(s, `convert to order as ${who}`, r.ok ? 'ALLOWED' : `${r.code}: ${r.message}`)
      if (r.ok) { po = r.rows[0].id; break }
    }
    expect(po).toBeTruthy()
    expect((await one('gm', 'select public.convert_purchase_request($1,$2,$3,$4::jsonb) id', [request, supplier, wh, costs])).id).toBe(po)
    await ok('procurement_mgr', 'select public.submit_purchase_order($1)', [po])
    await ok('procurement_mgr', 'select public.approve_purchase_order($1)', [po])
    const line = (await q('select id from public.purchase_order_lines where purchase_order_id=$1', [po]))[0].id
    const batch = `GRN-${rand()}`
    await ok('warehouse', 'select public.receive_goods($1,$2::jsonb,$3,null)', [po, J([{ po_line_id: line, quantity: 40, batch_number: batch, expiry_date: day(400), location_id: bin }]), 'DN-PILOT'])
    const bal = await q(`select sb.quantity,sb.location_id,b.batch_number,b.expiry_date from public.stock_balances sb join public.batches b on b.id=sb.batch_id where sb.organization_id=$1 and sb.product_id=$2`, [org.id, p.id])
    expect(bal).toHaveLength(1)
    expect([Number(bal[0].quantity), bal[0].location_id, bal[0].batch_number]).toEqual([40, bin, batch])
    expect(Number((await q('select coalesce(sum(quantity),0) n from public.stock_movements where organization_id=$1 and product_id=$2', [org.id, p.id]))[0].n)).toBe(40)
    const si = (await one('procurement', 'select public.record_supplier_invoice(null,$1,$2,current_date,0,null,$3::jsonb) id', [po, `SUP-${rand()}`, J([{ po_line_id: line, quantity: 40, unit_price: 12.5 }])])).id
    await ok('accounts_mgr', 'select public.approve_supplier_invoice($1)', [si])
    const owed = async () => money((await ok('accounts_mgr', 'select * from public.payables_summary()')).find((r) => r.supplier_id === supplier)?.outstanding ?? 0)
    expect(await owed()).toBe(500)
    await ok('accounts_mgr', 'select public.pay_supplier_invoice($1,current_date,$2)', [si, 'TRF-PILOT-1'])
    expect(await owed()).toBe(0)
    const jb = await journalsBalance()
    expect(money(jb.d)).toBe(money(jb.c))
    note(s, 'documents', (await q('select r.request_number, o.po_number from public.purchase_requests r join public.purchase_orders o on o.id=r.purchase_order_id where r.id=$1', [request]))[0])
    note(s, 'values', { received: 40, stock: 40, payable_before_payment: 500, payable_after_payment: 0, journals_balanced: true })
  })

  it('2. sales invoice and receipt', async () => {
    const s = '2'
    const p = await product('GSL', 25)
    await stock(p.id, 60, `EARLY-${rand()}`, day(120))
    const late = `LATE-${rand()}`
    await stock(p.id, 60, late, day(600))
    const c = await customer()
    const inv = await sell('cashier', c, p.id, 80)
    const alloc = await q('select b.batch_number,a.base_quantity from public.sales_invoice_allocations a join public.batches b on b.id=a.batch_id where a.sales_invoice_id=$1 order by b.expiry_date', [inv.id])
    expect(alloc.map((a) => Number(a.base_quantity))).toEqual([60, 20])          // first expiry first
    const total = money(inv.total_amount ?? inv.total ?? inv.grand_total)
    const receipt = (await one('cashier', `select public.record_receipt($1,$2,$3,'CASH',null,null) r`, [c, org.hq, total])).r
    const after = (await q('select * from public.sales_invoices where id=$1', [inv.id]))[0]
    const outstanding = money(total - money(after.amount_paid ?? after.paid_amount ?? 0))
    expect(outstanding).toBe(0)
    const jb = await journalsBalance()
    expect(money(jb.d)).toBe(money(jb.c))
    const checks = await ok('accounts_mgr', 'select * from public.accounting_checks()')
    note(s, 'control checks', checks.map((x) => ({ check: x.check_code, difference: Number(x.difference) })))
    for (const x of checks) expect(Math.abs(Number(x.difference)), x.check_code).toBeLessThan(0.01)
    note(s, 'documents', { invoice: inv.invoice_number, receipt: receipt.receipt_number ?? receipt.receipt_id })
    note(s, 'values', { total, outstanding_after_receipt: outstanding, fefo_allocation: alloc.map((a) => Number(a.base_quantity)) })
  })

  it('3. partial pick and substitution through packing', async () => {
    const s = '3'
    const p = await product()
    const first = `ORIG-${rand()}`
    await stock(p.id, 10, first, day(200))
    await stock(p.id, 10, `REPL-${rand()}`, day(400))
    await stock(p.id, 10, `SHORTDATED-${rand()}`, day(10))
    const c = await customer()
    await q('update public.customers set min_shelf_life_days=90 where id=$1', [c])
    const inv = await sell('sales_mgr', c, p.id, 8)
    const order = (await one('warehouse', 'select public.release_to_warehouse($1) id', [inv.id])).id
    await ok('picker', 'select public.claim_fulfilment_order($1)', [order])
    const line = (await q('select * from public.pick_lines where fulfilment_order_id=$1', [order]))[0]
    await ok('picker', `select public.confirm_pick_line($1,5,'NOT_FOUND')`, [line.id])
    const ex = (await q(`select id from public.fulfilment_exceptions where pick_line_id=$1 and status='OPEN'`, [line.id]))[0].id
    const choices = await ok('warehouse', 'select * from public.substitution_batch_options($1)', [ex])
    const offered = choices.map((x) => String(x.batch_number))
    expect(offered.some((b) => b.startsWith('SHORTDATED'))).toBe(false)
    expect(offered.some((b) => b.startsWith('REPL'))).toBe(true)
    const shortDated = (await q(`select id from public.batches where organization_id=$1 and batch_number like 'SHORTDATED%' and product_id=$2`, [org.id, p.id]))[0].id
    note(s, 'short-dated replacement', await refused('warehouse', 'select public.submit_batch_substitution($1,$2,$3)', [ex, shortDated, 'Try a batch below shelf life']))
    expect(evidence[s]!['short-dated replacement']).not.toBe('ALLOWED')
    const repl = choices.find((x) => String(x.batch_number).startsWith('REPL'))!
    await ok('warehouse', 'select public.submit_batch_substitution($1,$2,$3,$4)', [ex, repl.id, 'Three units missing from shelf', repl.stock_balance_id])
    await ok('packer', 'select public.start_packing($1)', [order])
    const pk = (await one('packer', `select public.create_package($1,'CARTON') id`, [order])).id
    await ok('packer', 'select public.pack_line($1,$2,5,$3)', [pk, line.id, line.batch_id])
    await ok('packer', 'select public.pack_line($1,$2,3,$3)', [pk, line.id, repl.id])
    // whoever chose the replacement counts as having picked it, so cannot also verify it
    note(s, 'substitution chooser verifying the packed line', await refused('warehouse', 'select public.verify_packed_line($1)', [line.id]))
    expect(evidence[s]!['substitution chooser verifying the packed line']).not.toBe('ALLOWED')
    await ok('packer', 'select public.finish_packing($1)', [order])
    const packed = await q('select b.batch_number,l.quantity from public.package_lines l join public.batches b on b.id=l.batch_id where l.package_id=$1 order by l.quantity desc', [pk])
    expect(packed.map((x) => Number(x.quantity))).toEqual([5, 3])
    note(s, 'documents', { invoice: inv.invoice_number, order: (await q('select order_number from public.fulfilment_orders where id=$1', [order]))[0].order_number })
    note(s, 'values', { packed: packed.map((x) => `${String(x.batch_number).split('-')[0]}:${Number(x.quantity)}`), offered_batches: offered.map((b) => b.split('-')[0]) })
  })

  it('4. controlled goods: two people, and the register matches the ledger', async () => {
    const s = '4'
    const p = await product('CONTROLLED', 50)
    const batch = `CD-${rand()}`
    await stock(p.id, 30, batch)
    const batchId = (await q('select id from public.batches where organization_id=$1 and batch_number=$2', [org.id, batch]))[0].id
    note(s, 'sale to customer not authorised for controlled drugs', await (async () => {
      const c = await customer()
      const draft = await run('sales_rep', `select public.save_sales_invoice(null,$1,$2,null,null,$3::jsonb) id`, [c, wh, J([{ product_id: p.id, quantity: 1 }])])
      return draft.ok ? refused('sales_mgr', 'select public.post_sales_invoice($1)', [draft.rows[0].id]) : `${draft.code}: ${draft.message}`
    })())
    expect(evidence[s]!['sale to customer not authorised for controlled drugs']).not.toBe('ALLOWED')
    const adj = (await one('warehouse', `select public.request_controlled_adjustment($1,$2::jsonb,'DAMAGE','Two units crushed in pilot') r`, [wh, J([{ product_id: p.id, batch_id: batchId, location_id: bin, quantity: 2, direction: 'OUT' }])])).r
    const adjId = adj.id ?? adj.adjustment_id ?? adj
    note(s, 'requester approving own adjustment', await refused('warehouse', 'select public.approve_controlled_adjustment($1)', [adjId]))
    expect(evidence[s]!['requester approving own adjustment']).not.toBe('ALLOWED')
    const mine = (await one('gm', `select public.request_controlled_adjustment($1,$2::jsonb,'DAMAGE','Senior self approval check') r`, [wh, J([{ product_id: p.id, batch_id: batchId, location_id: bin, quantity: 1, direction: 'OUT' }])])).r
    const mineId = mine.id ?? mine.adjustment_id ?? mine
    note(s, 'senior approving own adjustment', await refused('gm', 'select public.approve_controlled_adjustment($1)', [mineId]))
    expect(evidence[s]!['senior approving own adjustment']).not.toBe('ALLOWED')
    await ok('gm', 'select public.cancel_controlled_adjustment($1)', [mineId])
    await ok('pharmacist', 'select public.approve_controlled_adjustment($1)', [adjId])
    const inv = await sell('sales_mgr', await customer({ controlled: true }), p.id, 5)
    const summary = (await ok('pharmacist', 'select * from public.controlled_drug_summary($1,$2,$3)', [day(-1), day(1), wh])).find((r) => r.product_id === p.id)!
    const ledger = Number((await q('select coalesce(sum(quantity),0) n from public.stock_balances where product_id=$1', [p.id]))[0].n)
    const register = await ok('pharmacist', 'select * from public.controlled_drug_register($1,$2,$3,$4)', [p.id, day(-1), day(1), wh])
    expect(ledger).toBe(23)
    expect(Number(summary.closing)).toBe(ledger)
    note(s, 'documents', { invoice: inv.invoice_number, register_lines: register.length })
    note(s, 'values', { opening_received: 30, adjusted: -2, issued: 5, ledger_closing: ledger, register_closing: Number(summary.closing) })
  })

  it('5. recall: trace, quarantine, recovery and release', async () => {
    const s = '5'
    const p = await product()
    const batch = `RC-${rand()}`
    await stock(p.id, 20, batch)
    const batchId = (await q('select id from public.batches where organization_id=$1 and batch_number=$2', [org.id, batch]))[0].id
    const inv = await sell('sales_mgr', await customer(), p.id, 6)
    await ok('warehouse', `select public.post_stock_document('STATUS_CHANGE',$1,$2::jsonb,null,'QUALITY_HOLD','Unrelated quality hold')`, [wh, J([{ product_id: p.id, batch_id: batchId, location_id: bin, quantity: 4, from_status: 'AVAILABLE', to_status: 'QUARANTINE' }])])
    const recall = (await one('pharmacist', `select public.create_recall('INTERNAL','II','Pilot recall','Stop supply and collect') id`)).id
    const scope = (await one('pharmacist', 'select public.add_recall_batch($1,$2) id', [recall, batchId])).id
    const exposure = await ok('pharmacist', 'select * from public.recall_customer_exposure($1)', [recall])
    expect(exposure.map((e) => [e.invoice_number, Number(e.quantity)])).toEqual([[inv.invoice_number, 6]])
    await ok('pharmacist', `select public.quarantine_recall_batch($1,'Recall quarantine')`, [scope])
    const blocked = await run('sales_rep', `select public.save_sales_invoice(null,$1,$2,null,null,$3::jsonb) id`, [await customer(), wh, J([{ product_id: p.id, quantity: 1 }])])
    note(s, 'selling recalled stock', blocked.ok ? await refused('sales_mgr', 'select public.post_sales_invoice($1)', [blocked.rows[0].id]) : `${blocked.code}: ${blocked.message}`)
    expect(evidence[s]!['selling recalled stock']).not.toBe('ALLOWED')
    await ok('pharmacist', `select public.record_recall_recovery($1,$2,6,'RECOVERED','All six collected from the customer')`, [scope, inv.id])
    await ok('pharmacist', `select public.cancel_recall($1,'Pilot investigation cleared the batch')`, [recall])
    const released = (await one('pharmacist', `select public.release_recall_batch($1,'Cleared after investigation') r`, [scope])).r
    const held = Number((await q(`select coalesce(sum(quantity),0) n from public.stock_balances where batch_id=$1 and stock_status='QUARANTINE'`, [batchId]))[0].n)
    expect(Number(released.released)).toBe(10)
    expect(held).toBe(4)                                                          // the unrelated hold stays
    note(s, 'documents', { invoice: inv.invoice_number })
    note(s, 'values', { traced_quantity: 6, released: Number(released.released), unrelated_quarantine_kept: held })
  })

  it('6. expense approval posts once', async () => {
    const s = '6'
    const expense = (await one('owner', `select public.save_gl_account(null,'6901','Office expense','EXPENSE') id`)).id
    const credit = (await one('owner', `select public.save_gl_account(null,'1901','Expense clearing','ASSET') id`)).id
    const submit = `select public.submit_expense($1,current_date,'Pilot vendor','Office supplies','R-PILOT',$2,$3,25) id`
    note(s, 'accounts officer submitting an expense', await refused('accounts', submit, [org.hq, expense, credit]))
    const id = (await one('accounts_mgr', submit, [org.hq, expense, credit])).id
    note(s, 'requester approving own expense', await refused('accounts_mgr', `select public.decide_expense($1,'APPROVE','Self approval')`, [id]))
    expect(evidence[s]!['requester approving own expense']).not.toBe('ALLOWED')
    const first = (await one('accounts_mgr2', `select public.decide_expense($1,'APPROVE','Receipt checked') id`, [id])).id
    expect((await one('accounts_mgr2', `select public.decide_expense($1,'APPROVE','Receipt checked') id`, [id])).id).toBe(first)
    const lines = (await q('select sum(debit) d,sum(credit) c,count(distinct journal_id)::int n from public.gl_journal_lines where journal_id=$1', [first]))[0]
    expect([money(lines.d), money(lines.c), lines.n]).toEqual([25, 25, 1])
    note(s, 'values', { debit: 25, credit: 25, journals_after_retry: 1 })
  })

  it('7. another organization sees none of the pilot records', async () => {
    const tables = ['products', 'customers', 'suppliers', 'sales_invoices', 'purchase_orders', 'stock_balances', 'stock_movements', 'gl_journal_lines', 'customer_receipts', 'supplier_invoices', 'recalls', 'expenses', 'fulfilment_orders', 'profiles', 'audit_logs']
    const leaked: string[] = []
    const refusedRead: string[] = []
    for (const t of tables) {
      // A missing table throws here, and an empty one would make the rival's zero meaningless.
      const sql = `select count(*)::int n from public.${t} where organization_id=$1`
      expect((await q(sql, [org.id]))[0].n, `${t} holds pilot records`).toBeGreaterThan(0)
      const r = await run(rival.ownerId, sql, [org.id])
      if (!r.ok) {
        expect(r.code, `${t}: ${r.message}`).toBe('42501')
        refusedRead.push(t)
      } else if (r.rows[0].n > 0) leaked.push(t)
    }
    expect(leaked).toEqual([])
    note('7', 'values', { tables_checked: tables.length, read_refused: refusedRead, leaked: leaked.length })
  })
})
