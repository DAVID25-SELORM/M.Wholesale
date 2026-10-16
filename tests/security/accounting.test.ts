import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addBranch, addProduct, addProductUnit, addSupplier, addUser, addWarehouse, admin, closePool, createOrg, withUser, type Org,
} from '../helpers/db'

// The accounting ledger and bank reconciliation, end to end. One organization lives through a story (the tests below depend on each other, in order):
// documents before go-live -> start accounting -> sales, receipts, credit note, refund, reversal, void, write-off, purchase and payment -> control checks
// -> manual journals -> bank statement -> period lock.

let a: Org
let b: Org
let wh: string
let branch2: string
let owner: string
let accounts: string    // ACCOUNTS_MANAGER
let officer: string     // ACCOUNTS_OFFICER: reconciles, no journals
let auditor: string
let cashier: string
let branchAcct: string  // ACCOUNTS_MANAGER limited to branch 2
let procurement: string
let storeman: string
let customer: string
let product: { id: string; baseUnitRowId: string }
let tomorrow: string

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
type Out = { ok: true; rows: any[] } | { ok: false; code: string; message: string }
const call = (user: string, sql: string, params: unknown[] = []): Promise<Out> => withUser(user, (c) => c.attempt(sql, params), { commit: true }) as Promise<Out>
const ok = async (p: Promise<Out>) => { const r = await p; if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`); return r.rows[0] }
const failure = async (p: Promise<Out>) => { const r = await p; return r.ok ? { code: 'ok', message: '' } : { code: r.code, message: r.message } }
const code = async (p: Promise<Out>) => (await failure(p)).code
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows
const asUser = async (user: string, sql: string, params: unknown[] = []) => withUser(user, async (c) => (await c.q(sql, params)).rows)
const num = (v: unknown) => Number(v)

/** Ledger balance (debit - credit) of a system account, optionally for one journal source. */
const bal = async (key: string, org = a.id) =>
  num((await q(`select coalesce(sum(l.debit - l.credit), 0) n from public.gl_journal_lines l join public.gl_accounts ac on ac.id = l.account_id
                where ac.organization_id = $1 and ac.system_key = $2`, [org, key]))[0].n)
const acct = async (key: string, org = a.id) => (await q(`select id from public.gl_accounts where organization_id = $1 and system_key = $2`, [org, key]))[0].id as string
const journalOf = async (source: string, sourceId: string, event = 'POST') =>
  (await q(`select j.*, (select jsonb_agg(jsonb_build_object('key', ac.system_key, 'code', ac.code, 'd', l.debit::float8, 'c', l.credit::float8) order by l.line_no)
                         from public.gl_journal_lines l join public.gl_accounts ac on ac.id = l.account_id where l.journal_id = j.id) as lines
            from public.gl_journals j where j.organization_id = $1 and j.source_type = $2 and j.source_id = $3 and j.event = $4`, [a.id, source, sourceId, event]))[0]
const linesOf = (j: any) => (j.lines as { key: string | null; code: string; d: number; c: number }[]).map((l) => `${l.key ?? l.code}:${l.d ? 'Dr' + l.d : 'Cr' + l.c}`)
const journalCount = async () => num((await q(`select count(*) n from public.gl_journals where organization_id = $1`, [a.id]))[0].n)

async function invoice(units: number): Promise<string> {
  const id = (await ok(call(owner, `select public.save_sales_invoice(null, $1, $2, null, null, $3::jsonb) as id`, [customer, wh, JSON.stringify([{ product_id: product.id, quantity: units }])]))).id
  await ok(call(owner, `select public.post_sales_invoice($1, null, null) as r`, [id]))
  return id
}

beforeAll(async () => {
  a = await createOrg('ACC-A')
  b = await createOrg('ACC-B')
  wh = await addWarehouse(a.id, a.hq, 'W1')
  branch2 = await addBranch(a.id, 'B2')
  owner = a.ownerId
  accounts = await addUser(a.id, 'ACCOUNTS_MANAGER')
  officer = await addUser(a.id, 'ACCOUNTS_OFFICER')
  auditor = await addUser(a.id, 'AUDITOR')
  cashier = await addUser(a.id, 'CASHIER')
  branchAcct = await addUser(a.id, 'ACCOUNTS_MANAGER', branch2)
  procurement = await addUser(a.id, 'PROCUREMENT_OFFICER')
  storeman = await addUser(a.id, 'WAREHOUSE_MANAGER')
  tomorrow = day(1)

  // a customer, a 15 % tax code, one product at 10 per unit with 200 in stock at cost 4
  const list = (await q(`insert into public.price_lists (organization_id, code, name, is_default) values ($1, 'RETAIL', 'Retail', true) returning id`, [a.id]))[0].id
  customer = (await q(`insert into public.customers (organization_id, code, name, customer_type, licence_number, licence_expiry, payment_terms_days, credit_limit)
                       values ($1, 'AC1', 'Accounting customer', 'PHARMACY', 'PC/9', $2, 30, 10000000) returning id`, [a.id, day(300)]))[0].id
  const tax = (await q(`insert into public.tax_codes (organization_id, code, name, rate) values ($1, 'VAT15', 'VAT 15%', 15) returning id`, [a.id]))[0].id
  product = await addProduct(a.id, { cls: 'GSL' })
  await q(`update public.products set tax_code_id = $2 where id = $1`, [product.id, tax])
  await q(`insert into public.price_list_items (organization_id, price_list_id, product_id, product_unit_id, unit_price) values ($1, $2, $3, $4, 10)`, [a.id, list, product.id, product.baseUnitRowId])
  await ok(call(owner, `select public.post_stock_document('OPENING', $1, $2::jsonb) as r`, [wh, JSON.stringify([{ product_id: product.id, quantity: 200, batch_number: 'B0', expiry_date: day(400), unit_cost: 4 }])]))
})
afterAll(closePool)

describe('chart of accounts', () => {
  it('gives every organization the standard chart and its bank accounts, and nobody can touch them directly', async () => {
    for (const org of [a, b]) {
      const rows = await q(`select code, system_key, normal_side from public.gl_accounts where organization_id = $1 order by code`, [org.id])
      expect(rows.length).toBeGreaterThanOrEqual(26)
      for (const key of ['CASH', 'BANK', 'MOBILE_MONEY', 'CARD_CLEARING', 'AR', 'INVENTORY', 'AP', 'GRNI', 'VAT_OUTPUT', 'VAT_INPUT', 'SALES', 'SALES_RETURNS', 'COGS', 'STOCK_ADJUSTMENTS', 'PURCHASE_VARIANCE', 'ROUNDING', 'OPENING_EQUITY', 'BANK_CHARGES']) {
        expect(rows.some((r) => r.system_key === key), key).toBe(true)
      }
      expect(rows.find((r) => r.system_key === 'SALES_RETURNS')!.normal_side).toBe('DEBIT')
      const banks = await q(`select name, is_default from public.bank_accounts where organization_id = $1 order by name`, [org.id])
      expect(banks).toEqual([{ name: 'Main bank account', is_default: true }, { name: 'Mobile money wallet', is_default: false }])
    }
    for (const sql of [
      `insert into public.gl_accounts (code, name, account_type, normal_side) values ('9999', 'Mine', 'ASSET', 'DEBIT')`,
      `update public.gl_accounts set name = 'x'`, `delete from public.gl_accounts`,
      `insert into public.gl_journals (organization_id, journal_number, journal_date, source_type, description) values (gen_random_uuid(), 'X', current_date, 'MANUAL', 'fake')`,
      `update public.bank_accounts set is_default = false`, `insert into public.accounting_settings (go_live_date) values (current_date)`,
    ]) {
      expect(await code(call(owner, sql)), sql).toBe('42501')
    }
  })

  it('lets only managers edit the chart, protects system accounts, and hides the ledger from people without the right', async () => {
    expect(await code(call(officer, `select public.save_gl_account(null, '6500', 'Insurance', 'EXPENSE')`))).toBe('42501')
    const id = (await ok(call(accounts, `select public.save_gl_account(null, '6500', 'Insurance', 'EXPENSE') as id`))).id
    expect(await code(call(accounts, `select public.save_gl_account(null, '6500', 'Duplicate code', 'EXPENSE')`))).toBe('23505')
    await ok(call(accounts, `select public.save_gl_account($1, '6500', 'Insurance and licences', 'EXPENSE', true)`, [id]))
    const ar = await acct('AR')
    expect(await code(call(accounts, `select public.save_gl_account($1, '1100', 'Debtors', 'LIABILITY')`, [ar]))).toBe('23514')
    expect(await code(call(accounts, `select public.save_gl_account($1, '1100', 'Debtors', 'ASSET', false)`, [ar]))).toBe('23514')
    await ok(call(accounts, `select public.save_gl_account($1, '1100', 'Debtors (customers)', 'ASSET', true)`, [ar]))
    await ok(call(accounts, `select public.save_gl_account($1, '1100', 'Accounts receivable (customers)', 'ASSET', true)`, [ar]))
    expect((await asUser(auditor, `select count(*)::int n from public.gl_accounts`))[0].n).toBeGreaterThan(20)
    expect((await asUser(cashier, `select count(*)::int n from public.gl_accounts`))[0].n).toBe(0)
    expect((await asUser(b.ownerId, `select count(*)::int n from public.gl_accounts where organization_id = $1`, [a.id]))[0].n).toBe(0)
  })
})

describe('before accounting starts', () => {
  it('leaves documents alone: no journals, no manual journals, no reports to run', async () => {
    const i1 = await invoice(10)                      // 10 units at 10 + 15 % = 115, owed by the customer
    expect(await journalCount()).toBe(0)
    expect(await code(call(accounts, `select public.post_manual_journal(current_date, 'Rent', $1::jsonb)`,
      [JSON.stringify([{ account_id: await acct('CASH'), credit: 10 }, { account_id: (await q(`select id from public.gl_accounts where organization_id = $1 and code = '6100'`, [a.id]))[0].id, debit: 10 }])]))).toBe('55000')
    expect(i1).toBeTruthy()
  })
})

describe('starting accounting', () => {
  it('suggests opening balances from the operational records and refuses people without the manage right', async () => {
    expect(await code(call(officer, `select * from public.suggest_opening_balances()`))).toBe('42501')
    expect(await code(call(officer, `select public.start_accounting(current_date, '[]'::jsonb)`))).toBe('42501')
    const rows = (await asUser(owner, `select code, suggested::float8 s from public.suggest_opening_balances() order by code`))
    expect(Object.fromEntries(rows.map((r) => [r.code, r.s]))).toEqual({ '1100': 115, '1200': 760, '2000': 0 })
  })

  it('posts one balanced opening journal (equity is the balancing figure), clears the bank lines, and can only be done once', async () => {
    expect(await code(call(owner, `select public.start_accounting(current_date + 90, '[]'::jsonb)`))).toBe('22023')
    const lines = [
      { account_id: await acct('CASH'), debit: 1000 }, { account_id: await acct('BANK'), debit: 5000 },
      { account_id: await acct('AR'), debit: 115 }, { account_id: await acct('INVENTORY'), debit: 760 },
    ]
    expect(await code(call(owner, `select public.start_accounting(current_date, $1::jsonb)`, [JSON.stringify([{ account_id: await acct('CASH'), debit: 5, credit: 5 }])]))).toBe('22023')
    const j = (await ok(call(owner, `select public.start_accounting(current_date, $1::jsonb) as id`, [JSON.stringify(lines)]))).id
    expect(j).toBeTruthy()
    expect(await bal('OPENING_EQUITY')).toBe(-6875)
    expect(await bal('CASH')).toBe(1000)
    expect(await code(call(owner, `select public.start_accounting(current_date, '[]'::jsonb)`))).toBe('23505')
    const cleared = await q(`select m.note from public.bank_matches m join public.gl_journal_lines l on l.id = m.journal_line_id where l.journal_id = $1`, [j])
    expect(cleared).toEqual([{ note: 'Opening balance' }])
    // ledger and records agree at the start
    const checks = await asUser(owner, `select check_code, difference::float8 d from public.accounting_checks() order by 1`)
    expect(checks).toEqual([{ check_code: 'AP', d: 0 }, { check_code: 'AR', d: 0 }, { check_code: 'INVENTORY', d: 0 }, { check_code: 'TRIAL', d: 0 }])
  })
})

describe('documents become journals', () => {
  let inv2: string
  let creditNote: string

  it('journals a sales invoice (receivable, sales, VAT) and its cost of goods sold, once', async () => {
    inv2 = await invoice(20)                         // 200 + 30 VAT = 230; cost 20 x 4 = 80
    expect(linesOf(await journalOf('SALES_INVOICE', inv2))).toEqual(['AR:Dr230', 'SALES:Cr200', 'VAT_OUTPUT:Cr30'])
    const stockDoc = (await q(`select stock_document_id from public.sales_invoices where id = $1`, [inv2]))[0].stock_document_id
    expect(linesOf(await journalOf('STOCK_DOCUMENT', stockDoc))).toEqual(['INVENTORY:Cr80', 'COGS:Dr80'])
    expect(await bal('AR')).toBe(345)
    expect(await bal('COGS')).toBe(80)
    expect(await bal('INVENTORY')).toBe(680)
  })

  it('journals receipts by method (cash, bank transfer) and reverses a voided one', async () => {
    const r1 = (await ok(call(owner, `select public.record_receipt($1, $2, 100, 'CASH', null, null) as r`, [customer, a.hq]))).r.receipt_id
    const r2 = (await ok(call(owner, `select public.record_receipt($1, $2, 50, 'BANK_TRANSFER', 'TRF-77', null) as r`, [customer, a.hq]))).r.receipt_id
    expect(linesOf(await journalOf('RECEIPT', r1))).toEqual(['CASH:Dr100', 'AR:Cr100'])
    expect(linesOf(await journalOf('RECEIPT', r2))).toEqual(['BANK:Dr50', 'AR:Cr50'])
    const r3 = (await ok(call(owner, `select public.record_receipt($1, $2, 30, 'MOBILE_MONEY', 'MM-1', null) as r`, [customer, a.hq]))).r.receipt_id
    await ok(call(owner, `select public.void_receipt($1, 'bounced')`, [r3]))
    expect(linesOf(await journalOf('RECEIPT', r3))).toEqual(['MOBILE_MONEY:Dr30', 'AR:Cr30'])
    expect(linesOf(await journalOf('RECEIPT', r3, 'REVERSE'))).toEqual(['MOBILE_MONEY:Cr30', 'AR:Dr30'])
    expect(await bal('MOBILE_MONEY')).toBe(0)
    expect(await bal('CASH')).toBe(1100)
    expect(await bal('BANK')).toBe(5050)
  })

  it('journals a credit note, its returned stock at cost, and a refund', async () => {
    const [l] = await q(`select id from public.sales_invoice_lines where sales_invoice_id = $1`, [inv2])
    creditNote = (await ok(call(owner, `select public.save_credit_note(null, $1, null, 'DAMAGED', null, $2::jsonb) as id`, [inv2, JSON.stringify([{ type: 'RETURN', invoice_line_id: l.id, quantity: 5, condition: 'QUARANTINE' }])]))).id
    await ok(call(owner, `select public.post_credit_note($1)`, [creditNote]))
    expect(linesOf(await journalOf('CREDIT_NOTE', creditNote))).toEqual(['SALES_RETURNS:Dr50', 'VAT_OUTPUT:Dr7.5', 'AR:Cr57.5'])
    const stockDoc = (await q(`select stock_document_id from public.sales_credit_notes where id = $1`, [creditNote]))[0].stock_document_id
    expect(linesOf(await journalOf('STOCK_DOCUMENT', stockDoc))).toEqual(['INVENTORY:Dr20', 'COGS:Cr20'])
    expect(await bal('AR')).toBe(137.5)
    // a customer overpays; 20 of the surplus goes back in cash
    const big = (await ok(call(owner, `select public.record_receipt($1, $2, 300, 'CASH', null, null) as r`, [customer, a.hq]))).r.receipt_id
    const refund = (await ok(call(owner, `select public.refund_customer('RECEIPT', $1, 20, 'CASH', 'R-1', null, null) as r`, [big]))).r.refund_id
    expect(linesOf(await journalOf('REFUND', refund))).toEqual(['AR:Dr20', 'CASH:Cr20'])
    expect(await bal('AR')).toBe(-142.5)
    expect(await bal('CASH')).toBe(1380)
  })

  it('reverses an invoice and its stock effect completely', async () => {
    const before = [await bal('AR'), await bal('SALES'), await bal('COGS'), await bal('INVENTORY'), await bal('VAT_OUTPUT')]
    const i3 = await invoice(10)
    expect(await bal('AR')).not.toBe(before[0])
    await ok(call(owner, `select public.reverse_sales_invoice($1, 'Cancelled')`, [i3]))
    expect(linesOf(await journalOf('SALES_INVOICE', i3, 'REVERSE'))).toEqual(['AR:Cr115', 'SALES:Dr100', 'VAT_OUTPUT:Dr15'])
    expect([await bal('AR'), await bal('SALES'), await bal('COGS'), await bal('INVENTORY'), await bal('VAT_OUTPUT')]).toEqual(before)
  })

  it('journals a stock write-off at cost', async () => {
    await ok(call(owner, `select public.post_stock_document('ADJUSTMENT', $1, $2::jsonb, null, 'DAMAGE', 'water') as r`, [wh, JSON.stringify([{ product_id: product.id, batch_number: 'B0', quantity: 3, direction: 'OUT' }])]))
    expect(await bal('STOCK_ADJUSTMENTS')).toBe(12)
    expect(await bal('INVENTORY')).toBe(688)
  })

  it('journals a purchase from receipt to payment: goods received not invoiced is cleared by the invoice, payables by the payment', async () => {
    const supplier = await addSupplier(a.id)
    const p2 = await addProduct(a.id, { cls: 'GSL' })
    const box = await addProductUnit(a.id, p2.id, 'BOX', 14)
    const po = (await ok(call(procurement, `select public.save_purchase_order(null, $1, $2, null, null, $3::jsonb, null) as id`, [supplier, wh, JSON.stringify([{ product_id: p2.id, product_unit_id: box, quantity: 10, unit_cost: 100 }])]))).id
    await ok(call(procurement, `select public.submit_purchase_order($1)`, [po]))
    await ok(call(owner, `select public.approve_purchase_order($1)`, [po]))
    const [pol] = await q(`select id from public.purchase_order_lines where purchase_order_id = $1`, [po])
    const grn = (await ok(call(storeman, `select public.receive_goods($1, $2::jsonb, null, null) as r`, [po, JSON.stringify([{ po_line_id: pol.id, quantity: 10, batch_number: 'P2B', expiry_date: day(400) }])]))).r
    expect(await bal('GRNI')).toBe(-1000)
    expect(await bal('INVENTORY')).toBe(1688)
    expect(grn).toBeTruthy()
    const si = (await ok(call(accounts, `select public.record_supplier_invoice(null, $1, $2, current_date, 150, null, $3::jsonb) as id`, [po, 'SUP-INV-1', JSON.stringify([{ po_line_id: pol.id, quantity: 10, unit_price: 100 }])]))).id
    await ok(call(owner, `select public.approve_supplier_invoice($1, null)`, [si]))
    expect(linesOf(await journalOf('SUPPLIER_INVOICE', si, 'APPROVE'))).toEqual(['GRNI:Dr1000', 'VAT_INPUT:Dr150', 'AP:Cr1150'])
    expect(await bal('GRNI')).toBe(0)
    expect(await bal('AP')).toBe(-1150)
    await ok(call(accounts, `select public.pay_supplier_invoice($1, current_date, 'CHQ-9')`, [si]))
    expect(linesOf(await journalOf('SUPPLIER_INVOICE', si, 'PAY'))).toEqual(['AP:Dr1150', 'BANK:Cr1150'])
    expect(await bal('AP')).toBe(0)
    expect(await bal('BANK')).toBe(3900)
  })

  it('keeps the ledger equal to the customer, stock and supplier records, and the books in balance', async () => {
    const checks = await asUser(owner, `select check_code, ledger::float8 l, operational::float8 o, difference::float8 d from public.accounting_checks() order by 1`)
    expect(checks).toEqual([
      { check_code: 'AP', l: 0, o: 0, d: 0 }, { check_code: 'AR', l: -142.5, o: -142.5, d: 0 },
      { check_code: 'INVENTORY', l: 1688, o: 1688, d: 0 }, { check_code: 'TRIAL', l: 0, o: 0, d: 0 },
    ])
    expect(await q(`select 1 from public.gl_journals j where organization_id = $1 and (select sum(debit) - sum(credit) from public.gl_journal_lines where journal_id = j.id) <> 0`, [a.id])).toEqual([])
    // one journal per source and event, ever
    expect(await q(`select source_type, source_id, event from public.gl_journals where organization_id = $1 and source_id is not null group by 1, 2, 3 having count(*) > 1`, [a.id])).toEqual([])
  })
})

describe('the ledger is evidence', () => {
  it('cannot be edited, deleted or truncated by anyone, and an unbalanced journal cannot be committed', async () => {
    for (const sql of [`update public.gl_journals set description = 'x'`, `delete from public.gl_journals`, `update public.gl_journal_lines set debit = 1`,
      `delete from public.gl_journal_lines`, `truncate public.gl_journals`, `truncate public.gl_journal_lines`]) {
      await expect(admin.query(sql), sql).rejects.toBeTruthy()                                       // (truncate is refused outright: the table is referenced by foreign keys)
      expect(await code(call(owner, sql)), sql).not.toBe('ok')
    }
    const client = await admin.connect()
    try {
      await client.query('begin')
      const j = (await client.query(
        `insert into public.gl_journals (organization_id, journal_number, journal_date, source_type, description) values ($1, 'JV-BAD', current_date, 'MANUAL', 'unbalanced') returning id`, [a.id])).rows[0].id
      await client.query(`insert into public.gl_journal_lines (organization_id, journal_id, line_no, account_id, journal_date, debit) values ($1, $2, 1, $3, current_date, 10)`, [a.id, j, await acct('CASH')])
      await expect(client.query('commit')).rejects.toMatchObject({ code: '23514' })
    } finally {
      await client.query('rollback').catch(() => undefined)
      client.release()
    }
  })
})

describe('manual journals', () => {
  let rent: string
  let journal: string
  beforeAll(async () => { rent = (await q(`select id from public.gl_accounts where organization_id = $1 and code = '6100'`, [a.id]))[0].id })
  const rentLines = async (amount: number, creditKey = 'CASH') => JSON.stringify([{ account_id: rent, debit: amount, memo: 'October rent' }, { account_id: await acct(creditKey), credit: amount }])

  it('lets the accounts manager post a balanced journal, and only to non-control accounts, inside an open period', async () => {
    expect(await code(call(officer, `select public.post_manual_journal(current_date, 'Rent', $1::jsonb)`, [await rentLines(100)]))).toBe('42501')
    expect(await code(call(cashier, `select public.post_manual_journal(current_date, 'Rent', $1::jsonb)`, [await rentLines(100)]))).toBe('42501')
    expect(await code(call(accounts, `select public.post_manual_journal(current_date, 'Rent', $1::jsonb)`, [JSON.stringify([{ account_id: rent, debit: 100 }, { account_id: await acct('CASH'), credit: 90 }])]))).toBe('23514')
    expect(await code(call(accounts, `select public.post_manual_journal(current_date, 'Rent', $1::jsonb)`, [await rentLines(100, 'AR')]))).toBe('23514')       // control account
    expect(await code(call(accounts, `select public.post_manual_journal(current_date, 'Rent', $1::jsonb)`, [await rentLines(100, 'INVENTORY')]))).toBe('23514')
    expect(await code(call(accounts, `select public.post_manual_journal(current_date - 5, 'Rent', $1::jsonb)`, [await rentLines(100)]))).toBe('22023')          // before go-live
    expect(await code(call(accounts, `select public.post_manual_journal(current_date + 1, 'Rent', $1::jsonb)`, [await rentLines(100)]))).toBe('22023')
    expect(await code(call(accounts, `select public.post_manual_journal(current_date, 'Rent', $1::jsonb)`, [JSON.stringify([{ account_id: rent, debit: 0, credit: 0 }, { account_id: await acct('CASH'), credit: 0 }])]))).toBe('22023')
    journal = (await ok(call(accounts, `select public.post_manual_journal(current_date, 'October rent', $1::jsonb, null, 'Monthly rent') as id`, [await rentLines(400)]))).id
    expect(await bal('CASH')).toBe(1380 - 400)
    const [j] = await q(`select * from public.gl_journals where id = $1`, [journal])
    expect(j).toMatchObject({ source_type: 'MANUAL', created_by: accounts, reason: 'Monthly rent' })
    expect(j.journal_number).toMatch(/^JV-/)
    expect((await q(`select count(*)::int n from public.audit_logs where action = 'gl_journal.created' and entity_id = $1`, [journal]))[0].n).toBe(1)
  })

  it('reverses a manual journal once, and refuses to reverse a document journal', async () => {
    expect(await code(call(accounts, `select public.reverse_journal($1, 'x')`, [journal]))).toBe('22023')
    expect(await code(call(officer, `select public.reverse_journal($1, 'posted twice by mistake')`, [journal]))).toBe('42501')
    const rev = (await ok(call(accounts, `select public.reverse_journal($1, 'posted twice by mistake') as id`, [journal]))).id
    expect(await bal('CASH')).toBe(1380)
    expect((await q(`select reverses_journal_id, source_type from public.gl_journals where id = $1`, [rev]))[0]).toMatchObject({ reverses_journal_id: journal, source_type: 'REVERSAL' })
    expect(await code(call(accounts, `select public.reverse_journal($1, 'again please')`, [journal]))).toBe('23505')
    const salesJournal = (await q(`select id from public.gl_journals where organization_id = $1 and source_type = 'SALES_INVOICE' limit 1`, [a.id]))[0].id
    expect(await code(call(accounts, `select public.reverse_journal($1, 'trying to unpost a sale')`, [salesJournal]))).toBe('23514')
  })

  it('lets a branch-limited accountant post for and see only their own branch', async () => {
    expect(await code(call(branchAcct, `select public.post_manual_journal(current_date, 'Branch rent', $1::jsonb)`, [await rentLines(10)]))).toBe('42501')                // no branch given: organization-wide only
    expect(await code(call(branchAcct, `select public.post_manual_journal(current_date, 'Branch rent', $1::jsonb, $2)`, [await rentLines(10), a.hq]))).toBe('42501')    // another branch
    const id = (await ok(call(branchAcct, `select public.post_manual_journal(current_date, 'Branch rent', $1::jsonb, $2) as id`, [await rentLines(10), branch2]))).id
    expect((await asUser(branchAcct, `select id from public.gl_journals`)).map((r) => r.id)).toEqual([id])
    expect((await asUser(branchAcct, `select count(*)::int n from public.gl_journal_lines`))[0].n).toBe(2)
    expect((await asUser(owner, `select count(*)::int n from public.gl_journals`))[0].n).toBeGreaterThan(10)
    const tb = await asUser(branchAcct, `select code, closing::float8 c from public.trial_balance(current_date, current_date, null) where closing <> 0 order by code`)
    expect(tb).toEqual([{ code: '1000', c: -10 }, { code: '6100', c: 10 }])
    await ok(call(accounts, `select public.reverse_journal($1, 'branch test only')`, [id]))
  })
})

describe('financial statements', () => {
  it('shows a trial balance that balances, a profit and loss, and a balance sheet where assets equal liabilities plus equity', async () => {
    const tb = await asUser(auditor, `select code, closing::float8 c, period_debit::float8 pd, period_credit::float8 pc, opening::float8 o from public.trial_balance(current_date, current_date, null)`)
    expect(tb.reduce((s, r) => s + r.c, 0)).toBeCloseTo(0, 2)
    expect(tb.reduce((s, r) => s + r.pd - r.pc + r.o, 0)).toBeCloseTo(0, 2)
    const pl = await asUser(auditor, `select code, account_type, amount::float8 amt from public.income_statement(current_date, current_date, null)`)
    const revenue = pl.filter((r) => r.account_type === 'REVENUE').reduce((s, r) => s + r.amt, 0)
    const expenses = pl.filter((r) => r.account_type === 'EXPENSE').reduce((s, r) => s + r.amt, 0)
    expect(pl.find((r) => r.code === '4000')!.amt).toBe(200)                                    // sales 200 (invoice 2); invoice 3 was reversed; invoice 1 pre-dates go-live
    expect(pl.find((r) => r.code === '4100')!.amt).toBe(-50)                                    // returns reduce revenue
    expect(pl.find((r) => r.code === '5000')!.amt).toBe(60)                                     // cost of goods: 80 - 20 returned
    expect(revenue - expenses).toBe(150 - 60 - 12)
    const bs = await asUser(auditor, `select section, amount::float8 a from public.balance_sheet(current_date, null)`)
    const total = (s: string) => bs.filter((r) => r.section === s).reduce((x, r) => x + r.a, 0)
    expect(total('ASSET')).toBeCloseTo(total('LIABILITY') + total('EQUITY'), 2)
    expect(await code(call(cashier, `select * from public.trial_balance(current_date, current_date, null)`))).toBe('ok')           // runs, but returns nothing
    expect((await asUser(cashier, `select count(*)::int n from public.trial_balance(current_date, current_date, null) where closing <> 0`))[0].n).toBe(0)
  })

  it('shows an account ledger with a running balance that ends at the trial balance figure', async () => {
    const cash = await acct('CASH')
    const rows = await asUser(owner, `select description, debit::float8 d, credit::float8 c, running::float8 r from public.account_ledger($1, current_date, current_date, null)`, [cash])
    expect(rows[0]).toMatchObject({ description: 'Opening balance', r: 0 })
    expect(rows[rows.length - 1].r).toBe(1380)
    expect(rows.length).toBeGreaterThan(5)
  })

  it('keeps two organizations apart', async () => {
    expect((await asUser(b.ownerId, `select count(*)::int n from public.gl_journals`))[0].n).toBe(0)
    expect(await code(call(b.ownerId, `select public.post_manual_journal(current_date, 'Cross', $1::jsonb)`, [JSON.stringify([{ account_id: await acct('CASH'), debit: 1 }, { account_id: await acct('BANK'), credit: 1 }])]))).toBe('55000')
    const rows = await asUser(b.ownerId, `select * from public.account_ledger($1, current_date, current_date, null)`, [await acct('CASH')])
    expect(rows.filter((r) => r.line_id)).toEqual([])
  })
})

describe('bank reconciliation', () => {
  let bank: string
  let statement: string
  const lines = [
    { date: day(0), description: 'Transfer from customer', reference: 'TRF-77', amount: 50 },
    { date: day(0), description: 'Cheque CHQ-9', reference: 'CHQ-9', amount: -1150 },
    { date: day(0), description: 'Monthly account charges', reference: 'CHG', amount: -12 },
  ]
  const imp = (user: string, o: { from?: string; to?: string; open?: number; close?: number; lines?: object[] } = {}) =>
    call(user, `select public.import_bank_statement($1, $2, $3, $4, $5, $6::jsonb, 'march.csv') as id`,
      [bank, o.from ?? day(0), o.to ?? day(0), o.open ?? 5000, o.close ?? 3888, JSON.stringify(o.lines ?? lines)])

  beforeAll(async () => { bank = (await q(`select id from public.bank_accounts where organization_id = $1 and is_default`, [a.id]))[0].id })

  it('imports a statement only when it adds up, does not overlap another, and follows the previous one', async () => {
    expect(await code(imp(auditor))).toBe('42501')
    expect(await code(imp(cashier))).toBe('42501')
    expect((await failure(imp(officer, { close: 3000 }))).message).toMatch(/does not add up/)
    expect(await code(imp(officer, { lines: [{ date: day(-30), amount: 5 }], close: 5005 }))).toBe('22023')            // line outside the period
    statement = (await ok(imp(officer))).id
    expect((await q(`select count(*)::int n from public.bank_statement_lines where statement_id = $1`, [statement]))[0].n).toBe(3)
    expect(await code(imp(officer))).toBe('23505')                                                                      // same period again
    expect((await failure(imp(officer, { from: tomorrow, to: tomorrow, open: 100, close: 110, lines: [{ date: tomorrow, amount: 10 }] }))).message).toMatch(/does not match the previous statement/)
    expect((await asUser(auditor, `select count(*)::int n from public.bank_statements`))[0].n).toBe(1)
    expect((await asUser(cashier, `select count(*)::int n from public.bank_statements`))[0].n).toBe(0)
  })

  it('suggests and automatically accepts only unambiguous matches, and refuses wrong manual matches', async () => {
    const sug = await asUser(owner, `select statement_line_id, amount::float8 a from public.suggest_bank_matches($1)`, [statement])
    expect(sug.map((s) => s.a).sort((x, y) => x - y)).toEqual([-1150, 50])
    const [fifty, charge] = [(await q(`select id from public.bank_statement_lines where statement_id = $1 and amount = 50`, [statement]))[0].id, (await q(`select id from public.bank_statement_lines where statement_id = $1 and amount = -12`, [statement]))[0].id]
    const wrong = (await q(`select l.id from public.gl_journal_lines l where l.account_id = $1 and l.debit = 50`, [await acct('BANK')]))[0].id
    expect((await failure(call(officer, `select public.match_bank_line($1, $2::uuid[])`, [charge, [wrong]]))).message).toMatch(/total .* but the statement line/)
    expect(num((await ok(call(officer, `select public.auto_match_statement($1) as n`, [statement]))).n)).toBe(2)
    expect((await q(`select amount::float8 a from public.bank_statement_lines where statement_id = $1 and matched order by amount`, [statement])).map((r) => r.a)).toEqual([-1150, 50])
    expect((await failure(call(officer, `select public.match_bank_line($1, $2::uuid[])`, [fifty, [wrong]]))).message).toMatch(/already matched/)
    await ok(call(officer, `select public.unmatch_bank_line($1)`, [fifty]))
    await ok(call(officer, `select public.match_bank_line($1, $2::uuid[])`, [fifty, [wrong]]))
  })

  it('books bank charges from the statement, and will not finish until the difference is nil and every line is matched', async () => {
    expect((await failure(call(officer, `select public.finalize_reconciliation($1)`, [statement]))).message).toMatch(/still unmatched/)
    const rec = async () => Object.fromEntries((await asUser(auditor, `select item, amount::float8 a from public.bank_reconciliation($1)`, [statement])).map((r) => [r.item, r.a]))
    expect(await rec()).toMatchObject({ STATEMENT_CLOSING: 3888, UNBOOKED_OUT: -12, LEDGER: 3900, DIFFERENCE: 0, UNMATCHED_LINES: 1 })
    const charge = (await q(`select id from public.bank_statement_lines where statement_id = $1 and amount = -12`, [statement]))[0].id
    const charges = await acct('BANK_CHARGES')
    expect(await code(call(officer, `select public.post_bank_entry($1, $2)`, [charge, await acct('BANK')]))).toBe('22023')     // not the bank account itself
    expect(await code(call(officer, `select public.post_bank_entry($1, $2)`, [charge, await acct('AR')]))).toBe('22023')       // not a control account
    const j = (await ok(call(officer, `select public.post_bank_entry($1, $2, 'Bank charges, October') as id`, [charge, charges]))).id
    expect(linesOf({ lines: await q(`select ac.system_key as key, ac.code, l.debit::float8 d, l.credit::float8 c from public.gl_journal_lines l join public.gl_accounts ac on ac.id = l.account_id where journal_id = $1 order by line_no`, [j]) })).toEqual(['BANK:Cr12', 'BANK_CHARGES:Dr12'])
    expect(await rec()).toMatchObject({ LEDGER: 3888, ADJUSTED_BANK: 3888, ADJUSTED_BOOK: 3888, DIFFERENCE: 0, UNMATCHED_LINES: 0, UNBOOKED_OUT: 0 })
    expect(await code(call(auditor, `select public.finalize_reconciliation($1)`, [statement]))).toBe('42501')
    await ok(call(officer, `select public.finalize_reconciliation($1)`, [statement]))
    expect((await q(`select status, reconciled_by from public.bank_statements where id = $1`, [statement]))[0]).toMatchObject({ status: 'RECONCILED', reconciled_by: officer })
  })

  it('locks a reconciled statement and shows a payment the bank has not yet seen as outstanding', async () => {
    const fifty = (await q(`select id from public.bank_statement_lines where statement_id = $1 and amount = 50`, [statement]))[0].id
    expect((await failure(call(officer, `select public.unmatch_bank_line($1)`, [fifty]))).message).toMatch(/reconciled and locked/)
    expect(await code(call(officer, `select public.finalize_reconciliation($1)`, [statement]))).toBe('55000')
    // a new payment in the books that the bank has not shown yet
    await ok(call(owner, `select public.record_receipt($1, $2, 75, 'BANK_TRANSFER', 'TRF-99', null)`, [customer, a.hq]))
    const ledger = await asUser(officer, `select journal_line_id, amount::float8 a, cleared from public.bank_ledger_lines($1, null, null, true)`, [bank])
    expect(ledger.map((l) => l.a)).toEqual([75])
    const open = await asUser(officer, `select count(*)::int n from public.bank_ledger_lines($1, null, null, false)`, [bank])
    expect(open[0].n).toBeGreaterThan(4)
    // a line inside a reconciled period cannot be cleared away
    expect(await code(call(officer, `select public.clear_ledger_lines($1, $2::uuid[], 'Deposit slip lost, bank to confirm')`, [bank, [ledger[0].journal_line_id]]))).toBe('55000')
    // on the wallet (no reconciled statement) a line that will never reach a statement is cleared by note, and the clearance can be taken back
    const wallet = (await q(`select id from public.bank_accounts where organization_id = $1 and name = 'Mobile money wallet'`, [a.id]))[0].id
    await ok(call(owner, `select public.record_receipt($1, $2, 15, 'MOBILE_MONEY', 'MM-2', null)`, [customer, a.hq]))
    const wl = await asUser(officer, `select journal_line_id, amount::float8 a from public.bank_ledger_lines($1, null, null, true)`, [wallet])
    expect(wl.map((l) => l.a)).toEqual([30, -30, 15])                  // the voided receipt and its reversal are open until cleared
    const mine = wl.filter((l) => l.a === 15)
    expect(await code(call(officer, `select public.clear_ledger_lines($1, $2::uuid[], 'x')`, [wallet, [mine[0].journal_line_id]]))).toBe('22023')
    expect(num((await ok(call(officer, `select public.clear_ledger_lines($1, $2::uuid[], 'Reversed by the operator, never on a statement') as n`, [wallet, [mine[0].journal_line_id]]))).n)).toBe(1)
    expect((await asUser(officer, `select count(*)::int n from public.bank_ledger_lines($1, null, null, true)`, [wallet]))[0].n).toBe(2)
    await ok(call(officer, `select public.unclear_ledger_line($1)`, [mine[0].journal_line_id]))
    expect((await asUser(officer, `select count(*)::int n from public.bank_ledger_lines($1, null, null, true)`, [wallet]))[0].n).toBe(3)
  })

  it('lets only people with the reconcile right create bank accounts, and gives each its own ledger account', async () => {
    expect(await code(call(auditor, `select public.create_bank_account('Savings')`))).toBe('42501')
    const id = (await ok(call(officer, `select public.create_bank_account('Savings account', 'Ecobank', '0012345') as id`))).id
    const row = (await q(`select b.name, b.is_default, ac.account_type, ac.code from public.bank_accounts b join public.gl_accounts ac on ac.id = b.gl_account_id where b.id = $1`, [id]))[0]
    expect(row).toMatchObject({ name: 'Savings account', is_default: false, account_type: 'ASSET', code: '1040' })
    expect(await code(call(accounts, `select public.save_bank_account($1, 'Savings account', 'Ecobank', '0012345', false, false)`, [id]))).toBe('ok')
    expect(await code(call(officer, `select public.save_bank_account($1, 'Savings', null, null, true, false)`, [id]))).toBe('42501')          // changing accounts needs the manage right
    await ok(call(accounts, `select public.save_bank_account($1, 'Savings account', 'Ecobank', '0012345', true, true)`, [id]))
    // the new default receives bank transfers from now on
    await ok(call(owner, `select public.record_receipt($1, $2, 10, 'BANK_TRANSFER', 'TRF-NEW', null)`, [customer, a.hq]))
    expect((await q(`select l.debit::float8 d from public.gl_journal_lines l join public.bank_accounts b on b.gl_account_id = l.account_id where b.id = $1`, [id]))).toEqual([{ d: 10 }])
  })
})

describe('closing a period', () => {
  it('locks the period: manual journals are refused and automatic ones move to the first open day', async () => {
    expect(await code(call(officer, `select public.set_period_lock(current_date, null)`))).toBe('42501')
    expect(await code(call(accounts, `select public.set_period_lock(current_date + 5, null)`))).toBe('22023')
    await ok(call(accounts, `select public.set_period_lock(current_date, null)`))
    const rent = (await q(`select id from public.gl_accounts where organization_id = $1 and code = '6100'`, [a.id]))[0].id
    expect(await code(call(accounts, `select public.post_manual_journal(current_date, 'Late rent', $1::jsonb)`, [JSON.stringify([{ account_id: rent, debit: 5 }, { account_id: await acct('CASH'), credit: 5 }])]))).toBe('55000')
    const i4 = await invoice(2)
    const j = await journalOf('SALES_INVOICE', i4)
    expect(j.journal_date.toISOString().slice(0, 10)).toBe(tomorrow)
    expect((await q(`select invoice_date::text d from public.sales_invoices where id = $1`, [i4]))[0].d).toBe(day(0))
    expect(await code(call(accounts, `select public.set_period_lock(current_date - 1, null)`))).toBe('22023')                               // reopening needs a reason
    await ok(call(accounts, `select public.set_period_lock(current_date - 1, 'Late rent to be booked')`))
    await ok(call(accounts, `select public.post_manual_journal(current_date, 'Late rent', $1::jsonb)`, [JSON.stringify([{ account_id: rent, debit: 5 }, { account_id: await acct('CASH'), credit: 5 }])]))
    expect((await q(`select count(*)::int n from public.audit_logs where entity_type = 'accounting_settings' and action = 'accounting_settings.updated'`))[0].n).toBeGreaterThanOrEqual(2)
  })
})

describe('closed to the outside', () => {
  it('exposes nothing to anonymous callers', async () => {
    for (const t of ['gl_accounts', 'gl_journals', 'gl_journal_lines', 'accounting_settings', 'bank_accounts', 'bank_statements', 'bank_statement_lines', 'bank_matches']) {
      expect(await code(withUser(null, (c) => c.attempt(`select * from public.${t}`)) as Promise<Out>), t).toBe('42501')
    }
    expect(await code(withUser(null, (c) => c.attempt(`select * from public.trial_balance(current_date, current_date, null)`)) as Promise<Out>)).toBe('42501')
  })
})
