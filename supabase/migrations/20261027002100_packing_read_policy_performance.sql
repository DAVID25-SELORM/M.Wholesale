-- Evaluate permission scope once per query, as on the picking tables.
drop policy packages_read on public.packages;
create policy packages_read on public.packages for select to authenticated
using(organization_id=(select private.current_organization_id()) and
 ((select private.has_permission('fulfilment.view')) or branch_id in (select private.permitted_branches('fulfilment.view'))));
drop policy package_lines_read on public.package_lines;
create policy package_lines_read on public.package_lines for select to authenticated
using(organization_id=(select private.current_organization_id()) and
 ((select private.has_permission('fulfilment.view')) or branch_id in (select private.permitted_branches('fulfilment.view'))));
drop policy packing_verifications_read on public.packing_verifications;
create policy packing_verifications_read on public.packing_verifications for select to authenticated
using(organization_id=(select private.current_organization_id()) and
 ((select private.has_permission('fulfilment.view')) or branch_id in (select private.permitted_branches('fulfilment.view'))));
