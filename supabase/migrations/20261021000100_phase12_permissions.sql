-- Phase 12 / 01: permissions for deliveries, stock insight reports and the VAT report
--
--   deliveries.view      see delivery notes and pick lists
--   deliveries.create    prepare a delivery note for a posted invoice (this produces the pick list) and cancel it before dispatch
--   deliveries.dispatch  hand the goods to a driver, record proof of delivery, record a failed delivery
--   reports.stock        stock insight reports: reorder suggestions, slow-moving stock, stock likely to expire unsold
--   reports.tax          the VAT summary (output VAT on sales less input VAT on supplier invoices)

insert into public.permissions (code, module, action, description) values
  ('deliveries.view',     'deliveries', 'view',     'View delivery notes and pick lists'),
  ('deliveries.create',   'deliveries', 'create',   'Prepare and cancel delivery notes'),
  ('deliveries.dispatch', 'deliveries', 'dispatch', 'Dispatch goods and record delivery'),
  ('reports.stock',       'reports',    'stock',    'View stock insight reports'),
  ('reports.tax',         'reports',    'tax',      'View the VAT summary')
on conflict (code) do update set description = excluded.description;

with matrix(role_code, code) as (values
  ('SUPER_ADMIN','deliveries.view'),('SUPER_ADMIN','deliveries.create'),('SUPER_ADMIN','deliveries.dispatch'),('SUPER_ADMIN','reports.stock'),('SUPER_ADMIN','reports.tax'),
  ('OWNER','deliveries.view'),('OWNER','deliveries.create'),('OWNER','deliveries.dispatch'),('OWNER','reports.stock'),('OWNER','reports.tax'),
  ('GENERAL_MANAGER','deliveries.view'),('GENERAL_MANAGER','deliveries.create'),('GENERAL_MANAGER','deliveries.dispatch'),('GENERAL_MANAGER','reports.stock'),('GENERAL_MANAGER','reports.tax'),
  ('SALES_MANAGER','deliveries.view'),('SALES_MANAGER','deliveries.create'),('SALES_MANAGER','reports.stock'),
  ('BRANCH_MANAGER','deliveries.view'),('BRANCH_MANAGER','deliveries.create'),('BRANCH_MANAGER','deliveries.dispatch'),('BRANCH_MANAGER','reports.stock'),
  ('SALES_REP','deliveries.view'),
  ('CASHIER','deliveries.view'),
  ('WAREHOUSE_MANAGER','deliveries.view'),('WAREHOUSE_MANAGER','deliveries.create'),('WAREHOUSE_MANAGER','deliveries.dispatch'),('WAREHOUSE_MANAGER','reports.stock'),
  ('WAREHOUSE_PICKER','deliveries.view'),('WAREHOUSE_PICKER','deliveries.create'),
  ('WAREHOUSE_PACKER','deliveries.view'),('WAREHOUSE_PACKER','deliveries.create'),
  ('DISPATCHER','deliveries.view'),('DISPATCHER','deliveries.dispatch'),
  ('PROCUREMENT_MANAGER','reports.stock'),('PROCUREMENT_OFFICER','reports.stock'),
  ('ACCOUNTS_MANAGER','deliveries.view'),('ACCOUNTS_MANAGER','reports.tax'),
  ('ACCOUNTS_OFFICER','reports.tax'),
  ('AUDITOR','deliveries.view'),('AUDITOR','reports.stock'),('AUDITOR','reports.tax'),
  ('READ_ONLY','deliveries.view'),('READ_ONLY','reports.stock')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id
from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code = m.code
on conflict do nothing;
