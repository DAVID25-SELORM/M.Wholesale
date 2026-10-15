import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addProduct, addUser, addWarehouse, admin, closePool, createOrg, rand, withUser, type Org } from '../helpers/db'

// Volume test: a realistic year of a mid-sized wholesaler, built by cloning real posted documents in bulk, then the screens' own queries timed as real users under
// row-level security (including a branch-scoped user, whose every row costs a permission check).
//   node scripts/perf-test.mjs
// Scale (override with PERF_SCALE, e.g. 0.2 for a quick run): 3,000 products, 9,000 batches, 600 customers, 30,000 invoices, 15,000 receipts, 20,000 stock movements
// for one controlled product. Results are written to docs/PERFORMANCE.md.

const SCALE = Number(process.env.PERF_SCALE ?? 1)
const n = (v: number) => Math.max(10, Math.round(v * SCALE))
const PRODUCTS = n(3000), CUSTOMERS = n(600), INVOICES = n(30000), RECEIPTS = n(15000), MOVEMENTS = n(20000), FEFO_BATCHES = 600

let org: Org
let wh: string
let branchUser: string
let customerTemplate: string
let productTemplate: string
let heavyCustomer: string
const bulk = new pg.Pool({ host: '127.0.0.1', port: Number(process.env.WPS_TEST_PORT ?? 54522), user: 'supabase_admin', password: process.env.WPS_TEST_PASSWORD ?? 'wps_test_pw', database: 'wps_test', max: 2 })
const timings: { label: string; ms: number; rows: number | string; limit: number }[] = []
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows

/** insert-select clones of the rows matching `where`, `n` times; `g` is the copy number. Triggers (and so FK checks) are skipped for speed: the derived ids are consistent. */
async function clone(table: string, where: string, count: number, overrides: Record<string, string> = {}, params: unknown[] = []) {
  const cols = (await q(`select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 and is_generated = 'NEVER'
    and is_identity = 'NO' and (column_default is null or column_default not like 'nextval%') order by ordinal_position`, [table])).map((r) => r.column_name as string)
  const list = cols.map((c) => `"${c}"`).join(', ')
  const select = cols.map((c) => overrides[c] ?? `t."${c}"`).join(', ')
  const client = await bulk.connect()
  try {
    await client.query('begin')
    await client.query('set local session_replication_role = replica')
    await client.query(`insert into public.${table} (${list}) select ${select} from public.${table} t cross join generate_series(1, ${count}) g where ${where}`, params)
    await client.query('commit')
  } catch (e) {
    await client.query('rollback')
    throw new Error(`clone ${table}: ${(e as Error).message}`, { cause: e })
  } finally {
    client.release()
  }
}
const derive = (col: string, k = 'g') => `md5(t."${col}"::text || ${k}::text)::uuid`

async function time<T>(label: string, limit: number, user: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const t0 = performance.now()
  const rows = await withUser(user, async (c) => (await c.q(sql, params)).rows)
  const ms = Math.round(performance.now() - t0)
  timings.push({ label, ms, rows: rows.length, limit })
  return rows as T[]
}

beforeAll(async () => {
  org = await createOrg('PERF')
  wh = await addWarehouse(org.id, org.hq, 'PW1')
  const opening = (lines: object[]) => withUser(org.ownerId, (c) => c.q(`select public.post_stock_document('OPENING', $1, $2::jsonb) as r`, [wh, JSON.stringify(lines)]), { commit: true })
  branchUser = await addUser(org.id, 'SALES_MANAGER', org.hq)
  const list = (await q(`insert into public.price_lists (organization_id, code, name, is_default) values ($1, 'RETAIL', 'Retail', true) returning id`, [org.id]))[0].id
  customerTemplate = (await q(`insert into public.customers (organization_id, code, name, customer_type, licence_number, licence_expiry, payment_terms_days, credit_limit)
    values ($1, 'PC0', 'Perf customer 0', 'PHARMACY', 'PC/0', $2, 30, 100000000) returning id`, [org.id, day(300)]))[0].id
  const p0 = await addProduct(org.id, { cls: 'GSL' })
  productTemplate = p0.id
  await q(`insert into public.price_list_items (organization_id, price_list_id, product_id, product_unit_id, unit_price) values ($1, $2, $3, $4, 10)`, [org.id, list, p0.id, p0.baseUnitRowId])
  await opening([{ product_id: p0.id, quantity: 1_000_000, batch_number: 'B0', expiry_date: day(400), unit_cost: 4 }])
  const inv = (await withUser(org.ownerId, (c) => c.q(`select public.save_sales_invoice(null, $1, $2, null, null, $3::jsonb) as id`, [customerTemplate, wh, JSON.stringify([{ product_id: p0.id, quantity: 5 }])]), { commit: true })).rows[0].id
  await withUser(org.ownerId, (c) => c.q(`select public.post_sales_invoice($1)`, [inv]), { commit: true })
  await withUser(org.ownerId, (c) => c.q(`select public.record_receipt($1, $2, 25, 'CASH', null, null)`, [customerTemplate, org.hq]), { commit: true })

  const t0 = performance.now()
  // customers
  await clone('customers', `t.id = $1`, CUSTOMERS, { id: derive('id'), code: `'PC' || g`, name: `'Perf customer ' || g` }, [customerTemplate])
  // products with their base unit, price, one stock-holding batch and balance, plus a second batch per product
  await clone('products', `t.id = $1`, PRODUCTS, { id: derive('id'), sku: `'PERF' || g`, brand_name: `'Perf product ' || g` }, [productTemplate])
  await clone('product_units', `t.product_id = $1`, PRODUCTS, { id: derive('id'), product_id: derive('product_id') }, [productTemplate])
  await clone('price_list_items', `t.product_id = $1`, PRODUCTS, { id: derive('id'), product_id: derive('product_id'), product_unit_id: derive('product_unit_id') }, [productTemplate])
  await clone('batches', `t.product_id = $1`, PRODUCTS, { id: derive('id'), product_id: derive('product_id') }, [productTemplate])
  await clone('batches', `t.product_id = $1`, PRODUCTS, { id: `md5(t.id::text || 'b' || g::text)::uuid`, product_id: derive('product_id'), batch_number: `'B2-' || g`, expiry_date: `current_date + 200 + (g % 300)` }, [productTemplate])
  await clone('batch_costs', `t.batch_id in (select id from public.batches where product_id = $1)`, PRODUCTS, { batch_id: derive('batch_id') }, [productTemplate])
  await clone('stock_balances', `t.product_id = $1 and t.batch_id is not null`, PRODUCTS, { id: derive('id'), product_id: derive('product_id'), batch_id: derive('batch_id'), quantity: `100 + (g % 900)` }, [productTemplate])
  // a product with hundreds of batches, for first-expiry-first picking
  const fefo = await addProduct(org.id, { cls: 'GSL' })
  await q(`insert into public.price_list_items (organization_id, price_list_id, product_id, product_unit_id, unit_price) values ($1, $2, $3, $4, 3)`, [org.id, list, fefo.id, fefo.baseUnitRowId])
  await opening([{ product_id: fefo.id, quantity: 50, batch_number: 'F0', expiry_date: day(20), unit_cost: 1 }])
  await clone('batches', `t.product_id = $1`, FEFO_BATCHES, { id: derive('id'), batch_number: `'F' || g`, expiry_date: `current_date + 30 + g` }, [fefo.id])
  await clone('batch_costs', `t.batch_id in (select id from public.batches where product_id = $1 and batch_number = 'F0')`, FEFO_BATCHES, { batch_id: derive('batch_id') }, [fefo.id])
  await clone('stock_balances', `t.product_id = $1`, FEFO_BATCHES, { id: derive('id'), batch_id: derive('batch_id'), quantity: `50` }, [fefo.id])
  ;(globalThis as { __fefo?: string }).__fefo = fefo.id
  // a year of invoices (one line, one pick each), a third of them paid; customers and products spread evenly
  const invId = inv as string
  const spread = `(1 + (g % ${CUSTOMERS}))`
  await clone('sales_invoices', `t.id = $1`, INVOICES, {
    id: derive('id'), invoice_number: `'PERF-' || g`, customer_id: `md5($2::text || ${spread}::text)::uuid`, invoice_date: `current_date - (g % 360)`, due_date: `current_date + 30 - (g % 200)`,
    amount_paid: `case when g % 3 = 0 then t.total_amount else 0 end`, created_at: `now() - ((g % 360) || ' days')::interval - (g || ' seconds')::interval`, posted_at: `now() - ((g % 360) || ' days')::interval`,
  }, [invId, customerTemplate])
  const lineSpread = `(1 + (g % ${PRODUCTS}))`
  await clone('sales_invoice_lines', `t.sales_invoice_id = $1`, INVOICES, {
    id: derive('id'), sales_invoice_id: derive('sales_invoice_id'), product_id: `md5($2::text || ${lineSpread}::text)::uuid`, product_unit_id: `md5($3::text || ${lineSpread}::text)::uuid`,
  }, [invId, productTemplate, p0.baseUnitRowId])
  await clone('sales_invoice_allocations', `t.sales_invoice_id = $1`, INVOICES, {
    id: derive('id'), sales_invoice_id: derive('sales_invoice_id'), sales_invoice_line_id: derive('sales_invoice_line_id'), product_id: `md5($2::text || ${lineSpread}::text)::uuid`,
    batch_id: `md5($3::text || ${lineSpread}::text)::uuid`,
  }, [invId, productTemplate, (await q(`select id from public.batches where product_id = $1 and batch_number = 'B0'`, [productTemplate]))[0].id])
  await clone('customer_receipts', `t.customer_id = $1`, RECEIPTS, {
    id: derive('id'), receipt_number: `'PRCP-' || g`, customer_id: `md5($2::text || (1 + (g % ${CUSTOMERS}))::text)::uuid`, receipt_date: `current_date - (g % 360)`,
    created_at: `now() - ((g % 360) || ' days')::interval - (g || ' seconds')::interval`,
  }, [customerTemplate, customerTemplate])
  // 20,000 movements of the product used for the controlled-drugs register
  const openDoc = (await q(`select m.document_id from public.stock_movements m join public.stock_documents d on d.id = m.document_id where m.product_id = $1 and d.document_type = 'OPENING' limit 1`, [productTemplate]))[0].document_id
  await clone('stock_documents', `t.id = $1`, MOVEMENTS, { id: derive('id'), document_number: `'PERFD-' || g` }, [openDoc])
  await clone('stock_movements', `t.product_id = $1 and t.document_id = $2`, MOVEMENTS, { id: derive('id'), document_id: derive('document_id'), posted_at: `now() - ((g % 360) || ' days')::interval - (g || ' seconds')::interval` }, [productTemplate, openDoc])
  await admin.query(`update public.products set product_class = 'CONTROLLED', is_controlled = true, requires_prescription = true where id = $1`, [productTemplate])
  heavyCustomer = customerTemplate
  await admin.query('analyze')
  timings.push({ label: `(data built in ${Math.round((performance.now() - t0) / 1000)} s)`, ms: 0, rows: '', limit: 0 })
}, 900_000)

afterAll(async () => {
  const md = [
    '# Performance at volume', '',
    `Generated by \`node scripts/perf-test.mjs\` (tests/perf/volume.test.ts) on ${new Date().toISOString().slice(0, 10)}. Dataset: ${PRODUCTS.toLocaleString()} products, ${(PRODUCTS * 2).toLocaleString()} batches, ${CUSTOMERS.toLocaleString()} customers, ${INVOICES.toLocaleString()} invoices with lines and batch picks, ${RECEIPTS.toLocaleString()} receipts, ${MOVEMENTS.toLocaleString()} stock movements of one controlled medicine; local PostgreSQL 17 in Docker, queries run as real signed-in users under row-level security.`, '',
    '| Query | Time (ms) | Rows | Budget (ms) |', '|---|--:|--:|--:|',
    ...timings.filter((t) => t.limit > 0).map((t) => `| ${t.label} | ${t.ms} | ${t.rows} | ${t.limit} |`), '',
    timings.find((t) => t.limit === 0)?.label ?? '', '',
  ]
  writeFileSync(join(process.cwd(), 'docs', 'PERFORMANCE.md'), md.join('\n'))
  await bulk.end()
  await closePool()
})

describe('screens at volume (all queries as signed-in users, under row-level security)', () => {
  const owner = () => org.ownerId

  it('lists: invoices (page and count), open invoices of a customer, products, stock summary, expiry', async () => {
    await time('Invoices list: page of 20 with customer and warehouse', 800, owner(), `select i.*, c.name, w.name wname from public.sales_invoices i join public.customers c on c.id = i.customer_id join public.warehouses w on w.id = i.warehouse_id order by i.created_at desc, i.id limit 20`)
    await time('Invoices list: exact count (as the pager asks)', 1500, owner(), `select count(*) from public.sales_invoices`)
    await time('Invoices list: exact count, branch-scoped user', 2500, branchUser, `select count(*) from public.sales_invoices`)
    await time('Customer page: open invoices', 500, owner(), `select * from public.sales_invoices where customer_id = $1 and status = 'POSTED' and balance_due > 0 order by due_date limit 200`, [heavyCustomer])
    await time('Product search "perf product 12"', 800, owner(), `select * from public.search_products('perf product 12', 25, 0)`)
    await time('Stock summary (page of 50)', 1500, owner(), `select * from public.stock_summary(null, null, 90, 50, 0)`)
    await time('Expiring stock within 90 days', 1500, owner(), `select * from public.expiring_stock(90, null)`)
    await time('Dashboard: counts of drafts and open orders', 500, owner(), `select count(*) from public.sales_invoices where status = any (array['DRAFT'])`)
    const total = timings.filter((t) => t.limit > 0).every((t) => t.ms <= t.limit)
    expect(total, JSON.stringify(timings.filter((t) => t.limit > 0 && t.ms > t.limit))).toBe(true)
  })

  it('money: receivables ageing, customer credit and statement, sales report, VAT', async () => {
    await time('Receivables ageing (all customers)', 2500, owner(), `select * from public.receivables_summary()`)
    await time('Customer credit position', 500, owner(), `select * from public.customer_credit($1)`, [heavyCustomer])
    await time('Customer statement (one customer)', 1500, owner(), `select * from public.customer_statement($1)`, [heavyCustomer])
    await time('Overdue customers (reminders)', 2500, owner(), `select * from public.overdue_customers(1)`)
    await time('Sales report by day, one year', 4000, owner(), `select * from public.sales_report(current_date - 365, current_date, 'DAY', null)`)
    await time('Sales report by product, one year', 6000, owner(), `select * from public.sales_report(current_date - 365, current_date, 'PRODUCT', null)`)
    await time('Sales report by customer, one year', 5000, owner(), `select * from public.sales_report(current_date - 365, current_date, 'CUSTOMER', null)`)
    await time('Sales report by day, branch-scoped user', 6000, branchUser, `select * from public.sales_report(current_date - 365, current_date, 'DAY', null)`)
    await time('VAT summary, one year', 4000, owner(), `select * from public.vat_report(current_date - 365, current_date, null)`)
    expect(timings.filter((t) => t.limit > 0 && t.ms > t.limit).map((t) => `${t.label}: ${t.ms} ms`)).toEqual([])
  })

  it('stock insights and the controlled-drugs register', async () => {
    await time('Reorder suggestions (whole catalogue)', 8000, owner(), `select * from public.reorder_suggestions(null, 90, 30)`)
    await time('Slow-moving stock (180 days)', 6000, owner(), `select * from public.slow_moving_stock(180)`)
    await time('Stock likely to expire (180 days)', 6000, owner(), `select * from public.expiry_risk(180, 90, null)`)
    await time('Controlled-drugs summary (a month)', 3000, owner(), `select * from public.controlled_drug_summary(current_date - 30, current_date, null)`)
    await time('Controlled-drugs register, one year of one product', 4000, owner(), `select * from public.controlled_drug_register($1, current_date - 365, current_date, null)`, [productTemplate])
    await time('Stock valuation', 4000, owner(), `select * from public.stock_valuation(null)`)
    expect(timings.filter((t) => t.limit > 0 && t.ms > t.limit).map((t) => `${t.label}: ${t.ms} ms`)).toEqual([])
  })

  it('posting stays quick when the product has hundreds of batches (first-expiry-first)', async () => {
    const fefo = (globalThis as { __fefo?: string }).__fefo!
    const draft = async (qty: number) => (await withUser(owner(), (c) => c.q(`select public.save_sales_invoice(null, $1, $2, null, null, $3::jsonb) as id`, [customerTemplate, wh, JSON.stringify([{ product_id: fefo, quantity: qty }])]), { commit: true })).rows[0].id as string
    const id = await draft(2000)                                                             // spans about 40 batches
    const t0 = performance.now()
    await withUser(owner(), (c) => c.q(`select public.post_sales_invoice($1)`, [id]), { commit: true })
    const ms = Math.round(performance.now() - t0)
    timings.push({ label: 'Post an invoice picking 2,000 units across ~40 of 600 batches', ms, rows: 1, limit: 3000 })
    expect(ms).toBeLessThan(3000)
    const picks = (await q(`select count(*)::int n from public.sales_invoice_allocations where sales_invoice_id = $1`, [id]))[0].n
    expect(picks).toBeGreaterThan(30)
  })
})

void rand
