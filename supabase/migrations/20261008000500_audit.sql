-- Phase 0 / 05: audit log (append-only)
--
-- Rows are written only by SECURITY DEFINER code (triggers / private.write_audit).
-- Nobody - not authenticated users, not service_role, not the table owner - can
-- UPDATE, DELETE or TRUNCATE rows: a trigger refuses. (A database superuser could
-- still disable the trigger; that is outside the application trust boundary and
-- is covered by backups / log shipping in the operations plan.)

create table public.audit_logs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  -- deliberately NOT a foreign key: history must survive auth-user changes
  actor_user_id   uuid,
  action          text not null check (btrim(action) <> ''),
  entity_type     text not null check (btrim(entity_type) <> ''),
  entity_id       text,
  branch_id       uuid,
  previous_values jsonb,
  new_values      jsonb,
  metadata        jsonb,
  reason          text,
  -- wall-clock time (not transaction start) so events inside one transaction keep their order
  created_at      timestamptz not null default clock_timestamp()
);
-- Newest-first listing per organization is the dominant query; keyset friendly.
create index audit_logs_org_created_idx on public.audit_logs (organization_id, created_at desc, id desc);
create index audit_logs_org_branch_created_idx
  on public.audit_logs (organization_id, branch_id, created_at desc) where branch_id is not null;
create index audit_logs_org_actor_created_idx
  on public.audit_logs (organization_id, actor_user_id, created_at desc);
create index audit_logs_org_entity_idx on public.audit_logs (organization_id, entity_type, entity_id);
create index audit_logs_created_brin on public.audit_logs using brin (created_at);

create function private.audit_logs_block_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_logs is append-only (% refused)', tg_op using errcode = '42501';
end;
$$;

create trigger audit_logs_no_update_delete
  before update or delete on public.audit_logs
  for each row execute function private.audit_logs_block_mutation();
create trigger audit_logs_no_truncate
  before truncate on public.audit_logs
  for each statement execute function private.audit_logs_block_mutation();

-- The one way application code records a business event.
create function private.write_audit(
  p_organization_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text default null,
  p_branch_id uuid default null,
  p_previous jsonb default null,
  p_new jsonb default null,
  p_metadata jsonb default null,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.audit_logs (
    organization_id, actor_user_id, action, entity_type, entity_id, branch_id,
    previous_values, new_values, metadata, reason
  ) values (
    p_organization_id, auth.uid(), p_action, p_entity_type, p_entity_id, p_branch_id,
    p_previous, p_new, p_metadata, p_reason
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Generic row-change trigger. tg_argv[0] = entity type label (e.g. 'branch').
-- Actions: <entity>.created / .updated / .activated / .deactivated / .deleted.
-- Updates store only the columns that changed. A reason can be attached with
-- set_config('app.audit_reason', '...', true) inside the same transaction.
create function private.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entity text := tg_argv[0];
  v_old    jsonb;
  v_new    jsonb;
  v_row    jsonb;
  v_org    uuid;
  v_branch uuid;
  v_action text;
  v_prev   jsonb;
  v_next   jsonb;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new); v_row := v_new;
  elsif tg_op = 'UPDATE' then
    v_old := to_jsonb(old); v_new := to_jsonb(new); v_row := v_new;
  else
    v_old := to_jsonb(old); v_row := v_old;
  end if;

  v_org := coalesce(
    v_row ->> 'organization_id',
    case when tg_table_name = 'organizations' then v_row ->> 'id' end
  )::uuid;

  v_branch := case tg_table_name
    when 'branches' then (v_row ->> 'id')::uuid
    when 'warehouse_locations' then
      (select w.branch_id from public.warehouses w where w.id = (v_row ->> 'warehouse_id')::uuid)
    else (v_row ->> 'branch_id')::uuid
  end;

  if tg_op = 'INSERT' then
    v_action := v_entity || '.created';
    v_next := v_new;
  elsif tg_op = 'DELETE' then
    v_action := v_entity || '.deleted';
    v_prev := v_old;
  else
    select jsonb_object_agg(o.key, o.value) into v_prev
    from jsonb_each(v_old) o
    where o.key <> 'updated_at' and (v_new -> o.key) is distinct from o.value;

    select jsonb_object_agg(n.key, n.value) into v_next
    from jsonb_each(v_new) n
    where n.key <> 'updated_at' and (v_old -> n.key) is distinct from n.value;

    if v_next is null then
      return null; -- nothing but updated_at changed
    end if;

    v_action := case
      when (v_old -> 'is_active') is distinct from (v_new -> 'is_active')
           and (v_new ->> 'is_active')::boolean then v_entity || '.activated'
      when (v_old -> 'is_active') is distinct from (v_new -> 'is_active') then v_entity || '.deactivated'
      else v_entity || '.updated'
    end;
  end if;

  perform private.write_audit(
    v_org, v_action, v_entity, v_row ->> 'id', v_branch, v_prev, v_next,
    jsonb_build_object('table', tg_table_name),
    nullif(current_setting('app.audit_reason', true), '')
  );
  return null;
end;
$$;

revoke all on function private.write_audit(uuid, text, text, text, uuid, jsonb, jsonb, jsonb, text) from public;
revoke all on function private.audit_row_change() from public;
grant execute on function private.write_audit(uuid, text, text, text, uuid, jsonb, jsonb, jsonb, text)
  to service_role;

create trigger organizations_audit after update on public.organizations
  for each row execute function private.audit_row_change('organization');
create trigger branches_audit after insert or update or delete on public.branches
  for each row execute function private.audit_row_change('branch');
create trigger warehouses_audit after insert or update or delete on public.warehouses
  for each row execute function private.audit_row_change('warehouse');
create trigger warehouse_locations_audit after insert or update or delete on public.warehouse_locations
  for each row execute function private.audit_row_change('warehouse_location');
create trigger profiles_audit after insert or update or delete on public.profiles
  for each row execute function private.audit_row_change('user');
create trigger user_roles_audit after insert or update or delete on public.user_roles
  for each row execute function private.audit_row_change('user_role');
