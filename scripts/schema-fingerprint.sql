-- READ-ONLY. Run on the hosted database and on a freshly migrated local one, then compare the rows (kind, name, detail).
-- Catches migrations that were skipped or only half applied. Expected hosted-only differences: public.rls_auto_enable()
-- (Supabase's own) and the three trigram indexes, which name the extensions schema.
select kind, name, detail from (
  select 'column' as kind, c.table_schema || '.' || c.table_name || '.' || c.column_name as name,
         c.data_type || '|' || c.is_nullable || '|' || coalesce(c.column_default, '') as detail
    from information_schema.columns c where c.table_schema in ('public', 'private')
  union all
  select 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         md5(regexp_replace(p.prosrc, '\s+', '', 'g')) || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')
  union all
  select 'grant_fn', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         'anon=' || has_function_privilege('anon', p.oid, 'execute')::text || ' auth=' || has_function_privilege('authenticated', p.oid, 'execute')::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')
  union all
  select 'grant_table', n.nspname || '.' || c.relname,
         concat_ws(' ', 'anon:' || concat_ws(',', case when has_table_privilege('anon', c.oid, 'select') then 's' end, case when has_table_privilege('anon', c.oid, 'insert') then 'i' end, case when has_table_privilege('anon', c.oid, 'update') then 'u' end, case when has_table_privilege('anon', c.oid, 'delete') then 'd' end),
                        'auth:' || concat_ws(',', case when has_table_privilege('authenticated', c.oid, 'select') then 's' end, case when has_table_privilege('authenticated', c.oid, 'insert') then 'i' end, case when has_table_privilege('authenticated', c.oid, 'update') then 'u' end, case when has_table_privilege('authenticated', c.oid, 'delete') then 'd' end),
                        'rls=' || c.relrowsecurity::text)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v')
  union all
  select 'policy', schemaname || '.' || tablename || '.' || policyname,
         md5(regexp_replace(coalesce(qual, '') || '#' || coalesce(with_check, '') || '#' || cmd || '#' || array_to_string(roles, ','), '\s+', '', 'g'))
    from pg_policies where schemaname in ('public', 'private', 'storage')
  union all
  select 'trigger', n.nspname || '.' || c.relname || '.' || t.tgname, md5(regexp_replace(pg_get_triggerdef(t.oid), '\s+', '', 'g')) || '|' || t.tgenabled::text
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname in ('public', 'private', 'auth')
  union all
  select 'constraint', n.nspname || '.' || c.relname || '.' || k.conname, md5(regexp_replace(pg_get_constraintdef(k.oid), '\s+', '', 'g'))
    from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private')
  union all
  select 'index', schemaname || '.' || tablename || '.' || indexname, md5(regexp_replace(indexdef, '\s+', '', 'g'))
    from pg_indexes where schemaname in ('public', 'private')
  union all
  select 'role_permission', r.code || ':' || p.code, ''
    from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id where r.organization_id is null
) f order by 1, 2
