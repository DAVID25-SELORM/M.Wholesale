import { afterAll, describe, expect, it } from 'vitest'
import { admin, closePool } from '../helpers/db'

afterAll(closePool)

// Catalog-level checks: these fail the build if a future migration forgets RLS, leaves a
// SECURITY DEFINER function without a pinned search_path, or leaks a grant to anon/PUBLIC.

describe('catalog hardening', () => {
  it('every table in public has RLS enabled and at least one policy', async () => {
    const { rows } = await admin.query(`
      select c.relname, c.relrowsecurity,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')`)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.relrowsecurity, `${r.relname} RLS`).toBe(true)
      expect(r.policies, `${r.relname} policies`).toBeGreaterThan(0)
    }
  })

  it('anon holds no privileges on any public table or column', async () => {
    const t = await admin.query(`select table_name, privilege_type from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'`)
    expect(t.rows).toEqual([])
    const c = await admin.query(`select table_name, column_name from information_schema.column_privileges where grantee = 'anon' and table_schema = 'public'`)
    expect(c.rows).toEqual([])
  })

  it('authenticated can never DELETE / TRUNCATE / REFERENCE / TRIGGER anything in public', async () => {
    const { rows } = await admin.query(`
      select table_name, privilege_type from information_schema.role_table_grants
      where grantee = 'authenticated' and table_schema = 'public'
        and privilege_type in ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')`)
    expect(rows).toEqual([])
  })

  it('audit_logs is SELECT-only for authenticated', async () => {
    const { rows } = await admin.query(`
      select privilege_type from information_schema.role_table_grants
      where grantee = 'authenticated' and table_name = 'audit_logs' and table_schema = 'public'`)
    expect(rows.map((r) => r.privilege_type)).toEqual(['SELECT'])
    const cols = await admin.query(`
      select table_name from information_schema.column_privileges
      where grantee = 'authenticated' and table_schema = 'public' and table_name = 'audit_logs'
        and privilege_type in ('INSERT', 'UPDATE')`)
    expect(cols.rows).toEqual([])
  })

  it('tenant ownership columns are never client-writable', async () => {
    const { rows } = await admin.query(`
      select table_name, column_name, privilege_type from information_schema.column_privileges
      where grantee = 'authenticated' and table_schema = 'public'
        and privilege_type in ('INSERT', 'UPDATE')
        and column_name in ('organization_id', 'id', 'created_at', 'updated_at', 'warehouse_id_never')
        and not (table_name = 'warehouse_locations' and column_name = 'warehouse_id' )`)
    expect(rows).toEqual([])
    const sensitive = await admin.query(`
      select table_name, column_name from information_schema.column_privileges
      where grantee = 'authenticated' and table_schema = 'public' and privilege_type = 'UPDATE'
        and ((table_name = 'profiles' and column_name = 'is_active')
          or (table_name = 'organizations' and column_name = 'is_active')
          or (table_name = 'warehouses' and column_name = 'branch_id'))`)
    expect(sensitive.rows).toEqual([])
  })

  it('every function in public/private pins search_path', async () => {
    const { rows } = await admin.query(`
      select n.nspname || '.' || p.proname as fn, p.prosecdef, p.proconfig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private')`)
    expect(rows.length).toBeGreaterThan(10)
    for (const r of rows) {
      const pinned = (r.proconfig ?? []).some((c: string) => /^search_path=("")?$/.test(c) || c === 'search_path=""')
      expect(pinned, `${r.fn} search_path`).toBe(true)
    }
  })

  it('function EXECUTE grants match the intended public surface exactly', async () => {
    const { rows } = await admin.query(`
      select n.nspname || '.' || p.proname as fn,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as service
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prorettype <> 'trigger'::regtype`)
    expect(rows.filter((r) => r.anon).map((r) => r.fn)).toEqual([])
    const authed = rows.filter((r) => r.authed).map((r) => r.fn).sort()
    expect(authed).toEqual([
      'private.actor_covers_role', 'private.can_access_branch', 'private.can_access_warehouse',
      'private.current_organization_id', 'private.current_profile_id', 'private.has_permission',
      'private.has_permission_anywhere', 'private.normalize_text', 'private.warehouse_branch_id', 'public.assign_user_role', 'public.get_session_context',
      'public.prepare_invitation', 'public.prepare_resend', 'public.revoke_user_role', 'public.search_products', 'public.set_user_active',
    ])
    const service = rows.filter((r) => r.service).map((r) => r.fn)
    expect(service).toEqual(expect.arrayContaining(['public.provision_organization', 'public.provision_user', 'public.complete_invitation']))
    // provisioning is NOT available to signed-in users
    for (const fn of ['public.provision_organization', 'public.provision_user', 'public.complete_invitation']) {
      expect(authed).not.toContain(fn)
    }
  })

  it('trigger functions are not directly executable by clients', async () => {
    const { rows } = await admin.query(`
      select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prorettype = 'trigger'::regtype
        and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))`)
    expect(rows).toEqual([])
  })

  it('the private schema is not reachable by anon', async () => {
    const { rows } = await admin.query(`select has_schema_privilege('anon', 'private', 'USAGE') as anon, has_schema_privilege('authenticated', 'private', 'USAGE') as authed`)
    expect(rows[0]).toEqual({ anon: false, authed: true })
  })

  it('reference data: 20 system roles, none organization-owned, SUPER_ADMIN/OWNER hold every permission', async () => {
    const roles = await admin.query(`select count(*)::int n from public.roles where is_system_role and organization_id is null`)
    expect(roles.rows[0].n).toBe(20)
    const total = (await admin.query('select count(*)::int n from public.permissions')).rows[0].n
    for (const code of ['SUPER_ADMIN', 'OWNER']) {
      const n = await admin.query(`
        select count(*)::int n from public.role_permissions rp join public.roles r on r.id = rp.role_id
        where r.code = $1 and r.organization_id is null`, [code])
      expect(n.rows[0].n, code).toBe(total)
    }
    const gm = await admin.query(`
      select pm.code from public.role_permissions rp join public.roles r on r.id = rp.role_id
      join public.permissions pm on pm.id = rp.permission_id where r.code = 'GENERAL_MANAGER'`)
    expect(gm.rows.map((r) => r.code)).not.toContain('roles.manage')
    expect(gm.rows.map((r) => r.code)).not.toContain('organizations.manage')
  })
})
