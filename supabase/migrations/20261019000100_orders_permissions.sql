-- Phase 10 / 01: permissions for quotations and sales orders
--
--   quotations.view / create   see, draft, send, reject and cancel quotations and turn an accepted one into an order (branch of the dispatching warehouse)
--   orders.view / create       see, draft and cancel draft sales orders
--   orders.confirm             confirm an order: it numbers it and RESERVES the stock for the customer
--   orders.manage              cancel a confirmed order, or close it short (release what was never delivered)
-- Invoicing an order needs sales.create / sales.post as for any invoice; prices, discounts and credit rules are those of invoices.

insert into public.permissions (code, module, action, description) values
  ('quotations.view',   'quotations', 'view',    'View quotations'),
  ('quotations.create', 'quotations', 'create',  'Draft, send and convert quotations'),
  ('orders.view',       'orders',     'view',    'View sales orders'),
  ('orders.create',     'orders',     'create',  'Draft and cancel draft sales orders'),
  ('orders.confirm',    'orders',     'confirm', 'Confirm sales orders and reserve stock for them'),
  ('orders.manage',     'orders',     'manage',  'Cancel confirmed orders or close them short')
on conflict (code) do update set description = excluded.description;

with matrix(role_code, code) as (values
  ('SUPER_ADMIN','quotations.view'),('SUPER_ADMIN','quotations.create'),('SUPER_ADMIN','orders.view'),('SUPER_ADMIN','orders.create'),('SUPER_ADMIN','orders.confirm'),('SUPER_ADMIN','orders.manage'),
  ('OWNER','quotations.view'),('OWNER','quotations.create'),('OWNER','orders.view'),('OWNER','orders.create'),('OWNER','orders.confirm'),('OWNER','orders.manage'),
  ('GENERAL_MANAGER','quotations.view'),('GENERAL_MANAGER','quotations.create'),('GENERAL_MANAGER','orders.view'),('GENERAL_MANAGER','orders.create'),('GENERAL_MANAGER','orders.confirm'),('GENERAL_MANAGER','orders.manage'),
  ('SALES_MANAGER','quotations.view'),('SALES_MANAGER','quotations.create'),('SALES_MANAGER','orders.view'),('SALES_MANAGER','orders.create'),('SALES_MANAGER','orders.confirm'),('SALES_MANAGER','orders.manage'),
  ('BRANCH_MANAGER','quotations.view'),('BRANCH_MANAGER','quotations.create'),('BRANCH_MANAGER','orders.view'),('BRANCH_MANAGER','orders.create'),('BRANCH_MANAGER','orders.confirm'),('BRANCH_MANAGER','orders.manage'),
  ('SALES_REP','quotations.view'),('SALES_REP','quotations.create'),('SALES_REP','orders.view'),('SALES_REP','orders.create'),
  ('CASHIER','quotations.view'),('CASHIER','orders.view'),
  ('ACCOUNTS_MANAGER','quotations.view'),('ACCOUNTS_MANAGER','orders.view'),
  ('ACCOUNTS_OFFICER','quotations.view'),('ACCOUNTS_OFFICER','orders.view'),
  ('WAREHOUSE_MANAGER','orders.view'),('WAREHOUSE_PICKER','orders.view'),('WAREHOUSE_PACKER','orders.view'),('DISPATCHER','orders.view'),
  ('PHARMACIST','orders.view'),
  ('AUDITOR','quotations.view'),('AUDITOR','orders.view'),
  ('READ_ONLY','quotations.view'),('READ_ONLY','orders.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id
from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code = m.code
on conflict do nothing;
