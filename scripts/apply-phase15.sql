-- Apply Phase 15 (application error log) to the hosted database in ONE atomic paste: the migration, verbatim, inside a single transaction.
-- Run it once in the Supabase SQL editor. If anything fails, nothing is changed.
begin;

-- ===== migration 20261024000100_client_error_log =====
-- Phase 15 / 01: application error log
--
-- When the app crashes or a screen fails in an unexpected way, the browser reports it here (message, stack, page path, who, which build) so the owner sees problems
-- without waiting for a user to complain. Best-effort and write-only for users: any signed-in user can report; only people with the audit right can read; rows cannot be
-- edited or deleted. Each user can report at most 50 errors an hour (a runaway loop cannot flood the table). No passwords, tokens or form contents are ever sent:
-- the browser sends the error text, its stack and the page PATH (no query string).

create table public.client_errors (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict,
  user_id          uuid not null,
  source           text not null check (source in ('render', 'window', 'promise', 'route')),
  message          text not null check (length(message) <= 500),
  stack            text check (stack is null or length(stack) <= 4000),
  page_path        text check (page_path is null or length(page_path) <= 300),
  app_version      text check (app_version is null or length(app_version) <= 40),
  user_agent       text check (user_agent is null or length(user_agent) <= 300),
  created_at       timestamptz not null default now()
);
create index client_errors_org_created_idx on public.client_errors (organization_id, created_at desc, id desc);
create index client_errors_user_idx on public.client_errors (user_id, created_at desc);
create trigger client_errors_append_only before update or delete on public.client_errors
  for each row execute function private.stock_block_mutation();

alter table public.client_errors enable row level security;
create policy client_errors_select on public.client_errors for select to authenticated
  using (organization_id = (select private.current_organization_id()) and (select private.has_permission('audit.view')));
revoke all on public.client_errors from public, anon, authenticated;
grant select on public.client_errors to authenticated;

create function public.report_client_error(p_source text, p_message text, p_stack text default null, p_page_path text default null, p_app_version text default null, p_user_agent text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_user uuid := auth.uid();
begin
  if v_org is null or v_user is null then
    return;                                   -- not a signed-in member of an organization: nothing to record
  end if;
  if p_source is null or p_source not in ('render', 'window', 'promise', 'route') or length(btrim(coalesce(p_message, ''))) = 0 then
    return;
  end if;
  if (select count(*) from public.client_errors e where e.user_id = v_user and e.created_at > now() - interval '1 hour') >= 50 then
    return;                                   -- a runaway loop must not flood the log
  end if;
  insert into public.client_errors (organization_id, user_id, source, message, stack, page_path, app_version, user_agent)
  values (v_org, v_user, p_source, left(p_message, 500), left(p_stack, 4000), left(split_part(coalesce(p_page_path, ''), '?', 1), 300), left(p_app_version, 40), left(p_user_agent, 300));
end;
$$;
revoke all on function public.report_client_error(text, text, text, text, text, text) from public, anon;
grant execute on function public.report_client_error(text, text, text, text, text, text) to authenticated;

commit;
