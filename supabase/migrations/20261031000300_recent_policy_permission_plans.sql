-- Keep recent module policies consistent with the existing once-per-query checks.
alter policy purchase_requests_read on public.purchase_requests using (
 organization_id=(select private.current_organization_id()) and (
 (select private.has_permission('purchasing.request')) or branch_id in (select private.permitted_branches('purchasing.request')) or
 (select private.has_permission('purchasing.request_approve')) or branch_id in (select private.permitted_branches('purchasing.request_approve'))));
alter policy recall_recovery_read on public.recall_recoveries using (
 organization_id=(select private.current_organization_id()) and ((select private.has_permission('recalls.view')) or (select private.has_permission('recalls.manage'))));
alter policy agreements_read on public.price_agreements using (
 organization_id=(select private.current_organization_id()) and ((select private.has_permission_anywhere('pricing.view')) or (select private.has_permission('pricing.manage'))));
alter policy quotation_read on public.supplier_quotations using (
 organization_id=(select private.current_organization_id()) and ((select private.has_permission('purchasing.view')) or branch_id in (select private.permitted_branches('purchasing.view'))));
alter policy expenses_read on public.expenses using (
 organization_id=(select private.current_organization_id()) and ((select private.has_permission('accounting.view')) or branch_id in (select private.permitted_branches('accounting.view'))));
do $$ declare t text; begin
 foreach t in array array['crm_territories','crm_representatives','crm_visits','crm_targets'] loop
 execute format('alter policy crm_read on public.%I using (organization_id=(select private.current_organization_id()) and ((select private.has_permission(''crm.view'')) or (select private.has_permission(''crm.manage''))))',t);
 end loop;
end $$;
