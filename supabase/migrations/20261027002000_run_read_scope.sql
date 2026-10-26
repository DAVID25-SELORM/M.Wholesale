-- Use the same branch/assigned-driver decision for table reads and RPC reads.
-- This helper returns only a boolean and always checks the session organization.
grant execute on function private.can_read_run(uuid) to authenticated;
drop policy delivery_runs_read on public.delivery_runs;
create policy delivery_runs_read on public.delivery_runs for select to authenticated
using(organization_id=(select private.current_organization_id()) and private.can_read_run(id));
drop policy delivery_run_stops_read on public.delivery_run_stops;
create policy delivery_run_stops_read on public.delivery_run_stops for select to authenticated
using(organization_id=(select private.current_organization_id()) and private.can_read_run(run_id));
