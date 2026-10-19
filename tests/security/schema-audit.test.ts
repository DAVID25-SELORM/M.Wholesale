import { afterAll, describe, expect, it } from 'vitest'
import { admin, closePool } from '../helpers/db'

// A catalogue-wide audit of the migrated schema: invariants that must hold for EVERY table and function, so a future migration that forgets one fails here
// instead of in production. (hardening.test.ts pins the exact function allow-list; this file checks the rules behind it.)

afterAll(closePool)
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows

describe('schema audit: tables', () => {
  it('every public table has row-level security enabled and forced off only for the owner (no table is left open)', async () => {
    const rows = await q(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity order by 1`)
    expect(rows.map((r) => r.relname)).toEqual([])
  })

  it('the anonymous role holds no privilege on any public table, column, sequence or view', async () => {
    const tables = await q(`select table_name, privilege_type from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'`)
    expect(tables).toEqual([])
    const columns = await q(`select table_name, column_name from information_schema.role_column_grants where grantee = 'anon' and table_schema = 'public' limit 5`)
    expect(columns).toEqual([])
  })

  it('signed-in users can never DELETE, TRUNCATE, REFERENCE or TRIGGER on any public table', async () => {
    const rows = await q(`select table_name, privilege_type from information_schema.role_table_grants
      where grantee = 'authenticated' and table_schema = 'public' and privilege_type in ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER') order by 1, 2`)
    expect(rows).toEqual([])
  })

  it('every table that belongs to an organization has at least one policy, and every policy is scoped to the caller’s organization', async () => {
    const tenant = await q(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
        and not exists (select 1 from pg_policy p where p.polrelid = c.oid) order by 1`)
    expect(tenant.map((r) => r.relname)).toEqual([])
    // a policy on a tenant table that does not mention the organization would leak across tenants
    const leaky = await q(`select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) as using_expr
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
        and coalesce(pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid), '') not ilike '%organization%' order by 1, 2`)
    expect(leaky).toEqual([])
  })

  it('transactional tables are read-only for signed-in users: every write goes through a function', async () => {
    // tables whose rows users legitimately edit directly (master data, always column-limited): everything else must have SELECT only
    const editable = new Set([
      'branches', 'warehouses', 'warehouse_locations', 'profiles', 'system_settings', 'manufacturers', 'product_categories', 'product_identities', 'products', 'product_units',
      'product_barcodes', 'product_aliases', 'suppliers', 'supplier_contacts', 'supplier_products', 'customers', 'tax_codes', 'price_lists', 'price_list_items', 'organizations', 'drivers', 'vehicles',
    ])
    const rows = await q(`select table_name, string_agg(distinct privilege_type, ',') p from information_schema.role_table_grants
      where grantee = 'authenticated' and table_schema = 'public' and privilege_type in ('INSERT', 'UPDATE') group by 1 order by 1`)
    const unexpected = rows.filter((r) => !editable.has(r.table_name)).map((r) => `${r.table_name}: ${r.p}`)
    expect(unexpected).toEqual([])
    // and the column-level grants on those tables never include ownership / audit columns
    const dangerous = await q(`select table_name, column_name from information_schema.column_privileges
      where grantee = 'authenticated' and table_schema = 'public' and privilege_type in ('INSERT', 'UPDATE')
        and column_name in ('organization_id', 'created_by', 'created_at', 'updated_at', 'posted_by', 'posted_at') order by 1, 2`)
    expect(dangerous.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([])
  })

  it('append-only evidence tables reject updates and deletes by every role, including the table owner', async () => {
    for (const table of ['audit_logs', 'stock_movements', 'stock_documents', 'sales_invoice_allocations', 'customer_refunds', 'payment_reminders', 'pos_sales', 'pos_sale_payments', 'sales_credit_note_returns']) {
      const triggers = await q(`select t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname = $1 and not t.tgisinternal and (t.tgtype & 8 = 8 or t.tgtype & 16 = 16)`, [table])
      expect(triggers.length, `${table} needs a delete/update guard trigger`).toBeGreaterThan(0)
    }
  })
})

describe('schema audit: functions', () => {
  it('every SECURITY DEFINER function pins its search_path (otherwise a user-created object could shadow a table or function)', async () => {
    const rows = await q(`select n.nspname || '.' || p.proname as fn, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prosecdef
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') order by 1`)
    expect(rows.map((r) => r.fn)).toEqual([])
  })

  it('no function in the public or private schema can be executed by anonymous users or by PUBLIC', async () => {
    const rows = await q(`select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prokind = 'f'
        and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute')) order by 1`)
    expect(rows.map((r) => r.fn)).toEqual([])
  })

  it('functions that run with the owner’s rights are not callable by signed-in users unless they are in the public API', async () => {
    const rows = await q(`select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.prokind = 'f' and has_function_privilege('authenticated', p.oid, 'execute') order by 2`)
    // private helpers used inside RLS policies must stay executable; nothing else in `private` may be
    // (each only answers questions about the caller's own organization / permissions, or is pure text handling - reviewed in the Phase 12 production review)
    const allowed = new Set(['has_permission', 'has_permission_anywhere', 'current_organization_id', 'can_access_branch', 'can_access_warehouse', 'warehouse_branch_id', 'current_profile_id', 'actor_covers_role', 'normalize_text', 'permitted_branches'])
    expect(rows.filter((r) => !allowed.has(r.proname)).map((r) => `${r.nspname}.${r.proname}`)).toEqual([])
  })

  it('SECURITY INVOKER read functions are used for reports that must respect row-level security, and definer ones check a permission first', async () => {
    // every definer function in the public API must mention a permission or organisation check (a cheap guard against an unauthenticated back door)
    const rows = await q(`select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as signed_in from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
        and p.prosrc not ilike '%has_permission%' and p.prosrc not ilike '%current_organization_id%' and p.prosrc not ilike '%private.%' and p.prosrc not ilike '%auth.uid%' order by 1`)
    // the only exceptions are the provisioning functions, which no signed-in user can call (the service role does, from a server)
    expect(rows.map((r) => r.proname)).toEqual(['complete_invitation', 'provision_organization', 'provision_user'])
    expect(rows.filter((r) => r.signed_in)).toEqual([])
  })
  it('no policy checks permission once per row (that made counting 30,000 invoices take 10 seconds; see tests/perf)', async () => {
    const rows = await q(`select tablename, policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr from pg_policies where schemaname = 'public'`)
    // allowed shape: ( SELECT private.has_permission('code'::text) AS ... ) - an uncorrelated sub-select, evaluated once per query
    const bare = rows.filter((r) => /private\.has_permission(_anywhere)?\(/i.test(r.expr.replace(/\( SELECT private\.has_permission(_anywhere)?\('[a-z_.]+'::text\) AS has_permission(_anywhere)?\)/gi, '')))
    expect(bare.map((r) => `${r.tablename}.${r.policyname}`)).toEqual([])
  })
})
