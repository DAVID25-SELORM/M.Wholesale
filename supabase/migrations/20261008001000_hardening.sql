-- Phase 0 / 10: final privilege hardening (deterministic, re-runnable)
--
-- Postgres grants EXECUTE on new functions to PUBLIC, and Supabase additionally grants it
-- to anon/authenticated through default privileges. Reset every function in the private
-- schema to "no one", then grant back exactly what RLS policies / column defaults need.
-- Trigger functions need no grant (privileges are checked at CREATE TRIGGER time).

revoke all on all functions in schema private from public, anon, authenticated;

grant execute on function
  private.current_organization_id(),
  private.current_profile_id(),
  private.has_permission(text, uuid),
  private.has_permission_anywhere(text),
  private.can_access_branch(uuid),
  private.warehouse_branch_id(uuid),
  private.can_access_warehouse(uuid),
  private.actor_covers_role(uuid)
to authenticated;

-- Future private functions start with no execute rights for anyone but their owner.
alter default privileges in schema private revoke execute on functions from public, anon, authenticated;

-- Same default for future public functions: nothing is callable until a migration grants it.
alter default privileges in schema public revoke execute on functions from public, anon;
