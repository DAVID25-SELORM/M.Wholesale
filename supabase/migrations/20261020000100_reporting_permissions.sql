-- Phase 11 / 01: permissions for sales reports, the controlled-drugs register and payment reminders
--
--   reports.sales        sales reports (revenue, tax, credits) for the branches the person is assigned to
--   reports.margins      ... and what the goods COST and the margin: cost prices are commercially sensitive, so this is a separate right
--   registers.controlled the controlled-drugs register (every movement of a controlled medicine, with a running balance and the counterparty)
--   reminders.view       see overdue customers and the reminders already sent
--   reminders.send       record that a payment reminder was sent to a customer

insert into public.permissions (code, module, action, description) values
  ('reports.sales',        'reports',   'sales',   'View sales reports'),
  ('reports.margins',      'reports',   'margins', 'See cost and margin in sales reports'),
  ('registers.controlled', 'registers', 'controlled', 'View the controlled-drugs register'),
  ('reminders.view',       'reminders', 'view',    'View overdue customers and payment reminders'),
  ('reminders.send',       'reminders', 'send',    'Record payment reminders sent to customers')
on conflict (code) do update set description = excluded.description;

with matrix(role_code, code) as (values
  ('SUPER_ADMIN','reports.sales'),('SUPER_ADMIN','reports.margins'),('SUPER_ADMIN','registers.controlled'),('SUPER_ADMIN','reminders.view'),('SUPER_ADMIN','reminders.send'),
  ('OWNER','reports.sales'),('OWNER','reports.margins'),('OWNER','registers.controlled'),('OWNER','reminders.view'),('OWNER','reminders.send'),
  ('GENERAL_MANAGER','reports.sales'),('GENERAL_MANAGER','reports.margins'),('GENERAL_MANAGER','registers.controlled'),('GENERAL_MANAGER','reminders.view'),('GENERAL_MANAGER','reminders.send'),
  ('SALES_MANAGER','reports.sales'),('SALES_MANAGER','reports.margins'),('SALES_MANAGER','reminders.view'),('SALES_MANAGER','reminders.send'),
  ('BRANCH_MANAGER','reports.sales'),('BRANCH_MANAGER','reports.margins'),('BRANCH_MANAGER','registers.controlled'),('BRANCH_MANAGER','reminders.view'),('BRANCH_MANAGER','reminders.send'),
  ('SALES_REP','reminders.view'),
  ('ACCOUNTS_MANAGER','reports.sales'),('ACCOUNTS_MANAGER','reports.margins'),('ACCOUNTS_MANAGER','reminders.view'),('ACCOUNTS_MANAGER','reminders.send'),
  ('ACCOUNTS_OFFICER','reports.sales'),('ACCOUNTS_OFFICER','reminders.view'),('ACCOUNTS_OFFICER','reminders.send'),
  ('PHARMACIST','registers.controlled'),
  ('WAREHOUSE_MANAGER','registers.controlled'),
  ('AUDITOR','reports.sales'),('AUDITOR','reports.margins'),('AUDITOR','registers.controlled'),('AUDITOR','reminders.view'),
  ('READ_ONLY','reports.sales'),('READ_ONLY','reminders.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id
from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code = m.code
on conflict do nothing;
