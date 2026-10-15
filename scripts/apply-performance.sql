-- Apply the performance fix (permission checks once per query) to the hosted database in ONE atomic paste: the migration, verbatim, inside a single transaction.
-- Run it once in the Supabase SQL editor. If anything fails, nothing is changed.
begin;

-- ===== migration 20261022000100_rls_permission_checks_once =====
-- Production readiness: evaluate permission checks once per query instead of once per row.
--
-- Found by the volume test (tests/perf/volume.test.ts). A policy such as
--     organization_id = current_org AND private.has_permission('sales.view', branch_id)
-- calls has_permission for EVERY row the query touches (about 0.3 ms each): counting 30,000 invoices took 10 s, a year's sales report 21 s.
--
-- The rewrite below keeps the rule exactly the same, but in a shape the planner evaluates once:
--     (select private.has_permission('sales.view'))                              -- organization-wide right: one check per query
--     OR branch_id in (select private.permitted_branches('sales.view'))          -- branch-scoped rights: one list per query, hashed
-- Every policy that called has_permission / has_permission_anywhere with a column (or a single warehouse-to-branch lookup) is rewritten in place from
-- the catalog, so no policy is retyped by hand. Only the expressions change: commands, roles and restrictive/permissive kind stay as they are.

create or replace function private.permitted_branches(p_code text)
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select ur.branch_id
  from public.user_roles ur
  join public.roles r on r.id = ur.role_id and r.is_active
  join public.role_permissions rp on rp.role_id = ur.role_id
  join public.permissions pm on pm.id = rp.permission_id
  where ur.user_id = (select auth.uid())
    and ur.organization_id = (select private.current_organization_id())
    and pm.code = p_code
    and ur.branch_id is not null
$$;
revoke all on function private.permitted_branches(text) from public, anon;
grant execute on function private.permitted_branches(text) to authenticated;

do $$
declare
  pol record;
  new_qual text;
  new_check text;
  n integer := 0;
  -- has_permission('code'::text, <column | warehouse_branch_id(column)>)
  two_arg constant text := 'private\.has_permission\((''[a-z_.]+''::text), ((?:private\.warehouse_branch_id\([a-z_]+\))|(?:[a-z_]+))\)';
  -- has_permission('code'::text) and has_permission_anywhere('code'::text): constant arguments, evaluated once with a sub-select
  one_arg constant text := 'private\.(has_permission|has_permission_anywhere)\((''[a-z_.]+''::text)\)';
begin
  for pol in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public' and (coalesce(qual, '') like '%private.has_permission%' or coalesce(with_check, '') like '%private.has_permission%')
  loop
    new_qual := pol.qual;
    new_check := pol.with_check;
    if new_qual is not null then
      new_qual := regexp_replace(new_qual, two_arg, '((select private.has_permission(\1)) or \2 in (select private.permitted_branches(\1)))', 'g');
      new_qual := regexp_replace(new_qual, '(?<!select )' || one_arg, '(select private.\1(\2))', 'g');
    end if;
    if new_check is not null then
      new_check := regexp_replace(new_check, two_arg, '((select private.has_permission(\1)) or \2 in (select private.permitted_branches(\1)))', 'g');
      new_check := regexp_replace(new_check, '(?<!select )' || one_arg, '(select private.\1(\2))', 'g');
    end if;
    if new_qual is distinct from pol.qual or new_check is distinct from pol.with_check then
      execute format('alter policy %I on %I.%I%s%s', pol.policyname, pol.schemaname, pol.tablename,
        case when new_qual is not null then ' using (' || new_qual || ')' else '' end,
        case when new_check is not null then ' with check (' || new_check || ')' else '' end);
      n := n + 1;
    end if;
  end loop;
  raise notice 'rewrote % polic(ies)', n;
end $$;

-- The same fix for the report functions (SECURITY DEFINER, so row-level security does not apply to them) that test permission per row in their own WHERE clauses:
-- has_permission('code', alias.branch_id) -> one check plus one hashed branch list per call. Rewritten from the catalog, definition and grants otherwise untouched.
do $$
declare
  fn record;
  def text;
  n integer := 0;
begin
  for fn in
    select p.oid, p.proname
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) ~ 'private\.has_permission\(''[a-z_.]+'', *[a-z]+\.[a-z_]+\)'
  loop
    def := regexp_replace(pg_get_functiondef(fn.oid),
      'private\.has_permission\((''[a-z_.]+''), *([a-z]+\.[a-z_]+)\)',
      '((select private.has_permission(\1)) or \2 in (select private.permitted_branches(\1)))', 'g');
    execute def;
    n := n + 1;
  end loop;
  raise notice 'rewrote % function(s)', n;
end $$;

-- Reorder suggestions looked up each product's stock by re-scanning the stock CTE once per product (thousands of scans on a large catalogue). Aggregate once per
-- product, and only for products that actually sold, then join.
do $$
declare
  def text := pg_get_functiondef('public.reorder_suggestions(uuid, integer, integer)'::regprocedure);
  fixed text;
begin
  fixed := replace(def,
    '           coalesce((select sum(s.q) from stock s where s.product_id = p.id), 0) as on_hand,
           coalesce((select sum(private.reserved_quantity(v_org, s.warehouse_id, p.id)) from stock s where s.product_id = p.id), 0) as reserved,',
    '           coalesce(h.on_hand, 0) as on_hand,
           coalesce(h.reserved, 0) as reserved,');
  fixed := replace(fixed,
    '    left join sold so on so.product_id = p.id
',
    '    left join sold so on so.product_id = p.id
    left join (select s.product_id, sum(s.q) as on_hand, sum(private.reserved_quantity(v_org, s.warehouse_id, s.product_id)) as reserved
               from stock s where s.product_id in (select x.product_id from sold x) group by s.product_id) h on h.product_id = p.id
');
  if fixed = def then raise exception 'reorder_suggestions definition not as expected'; end if;
  execute fixed;
end $$;

commit;
