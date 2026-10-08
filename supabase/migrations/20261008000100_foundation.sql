-- Phase 0 / 01: foundation
-- Private schema for security helpers (never exposed through the Data API),
-- shared trigger functions and shared types.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- Codes (branch, warehouse, location, ...) are short, upper-case, URL/label friendly.
create domain public.entity_code as text
  check (value ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$');

create type public.warehouse_type as enum
  ('MAIN', 'RETURNS', 'QUARANTINE', 'DAMAGED', 'TRANSIT', 'OTHER');

-- Maintains updated_at on every row update.
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Blocks changes to the named columns (trigger args). Applies to every role,
-- including service_role: tenant ownership and parentage never move.
create function private.prevent_column_change()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_col text;
begin
  foreach v_col in array tg_argv loop
    if (to_jsonb(new) -> v_col) is distinct from (to_jsonb(old) -> v_col) then
      raise exception 'column %.% is immutable', tg_table_name, v_col
        using errcode = '23514';
    end if;
  end loop;
  return new;
end;
$$;
