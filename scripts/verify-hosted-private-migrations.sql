-- READ-ONLY. Paste into the Supabase SQL editor. Changes nothing.
-- Confirms the four migrations that only alter private functions, triggers or policies, which the public API cannot reveal.
-- Every row should say true. A false row means that migration has not been applied.
select '20261030000300 platform usage limits' as migration,
       exists(select 1 from pg_trigger where tgname = 'profiles_platform_capacity' and not tgisinternal) as applied
union all
select '20261031000300 recent policy plans',
       (select (length(qual) - length(replace(lower(qual), 'select', ''))) / 6 >= 3 from pg_policies where schemaname = 'public' and policyname = 'recall_recovery_read')
union all
select '20261101000100 trial enforcement',
       exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'trial_access_allowed')
       and exists(select 1 from pg_trigger where tgname = 'subscription_trial_period' and not tgisinternal)
union all
select '20261104000100 partial substitution dispatch guard',
       exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'private' and p.proname = 'block_recalled_dispatch' and p.prosrc ilike '%fulfilment_substitutions%');
