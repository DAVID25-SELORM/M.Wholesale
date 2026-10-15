-- Phase 6 / 01: permissions for customers, pricing and tax, sales and receipts
--
--   customers.view / create / edit   organization-level master data (like products and suppliers)
--   pricing.view / manage            price lists and tax codes (manage = organization-wide)
--   sales.view / create / post       invoices belong to the branch of the warehouse they are dispatched from (branch-scoped)
--   sales.discount                   give a discount on a line
--   sales.price_override             sell at a price other than the customer's price list
--   sales.override_credit            post an invoice despite a credit hold / limit / expired customer licence (always with a reason)
--   receipts.view / create / void    money received from customers (branch-scoped)
-- Regulatory limits (controlled drugs, prescription-only medicines for unlicensed customers) can NOT be overridden by any permission.

insert into public.permissions (code, module, action, description) values
  ('customers.view',         'customers', 'view',             'View customers'),
  ('customers.create',       'customers', 'create',           'Create customers'),
  ('customers.edit',         'customers', 'edit',             'Edit customers, their credit terms and holds'),
  ('pricing.view',           'pricing',   'view',             'View price lists and tax codes'),
  ('pricing.manage',         'pricing',   'manage',           'Manage price lists and tax codes'),
  ('sales.view',             'sales',     'view',             'View sales invoices'),
  ('sales.create',           'sales',     'create',           'Create and edit draft sales invoices'),
  ('sales.post',             'sales',     'post',             'Post sales invoices (stock leaves, the customer owes)'),
  ('sales.discount',         'sales',     'discount',         'Give discounts on invoice lines'),
  ('sales.price_override',   'sales',     'price_override',   'Sell at a price other than the price list'),
  ('sales.override_credit',  'sales',     'override_credit',  'Post despite a credit hold, limit or expired customer licence'),
  ('receipts.view',          'receipts',  'view',             'View receipts and customer balances'),
  ('receipts.create',        'receipts',  'create',           'Record money received from customers'),
  ('receipts.void',          'receipts',  'void',             'Void a receipt (for example a bounced cheque)')
on conflict (code) do update set description = excluded.description;

with matrix(role_code, code) as (values
  -- full access
  ('SUPER_ADMIN','customers.view'),('SUPER_ADMIN','customers.create'),('SUPER_ADMIN','customers.edit'),('SUPER_ADMIN','pricing.view'),('SUPER_ADMIN','pricing.manage'),
  ('SUPER_ADMIN','sales.view'),('SUPER_ADMIN','sales.create'),('SUPER_ADMIN','sales.post'),('SUPER_ADMIN','sales.discount'),('SUPER_ADMIN','sales.price_override'),('SUPER_ADMIN','sales.override_credit'),
  ('SUPER_ADMIN','receipts.view'),('SUPER_ADMIN','receipts.create'),('SUPER_ADMIN','receipts.void'),
  ('OWNER','customers.view'),('OWNER','customers.create'),('OWNER','customers.edit'),('OWNER','pricing.view'),('OWNER','pricing.manage'),
  ('OWNER','sales.view'),('OWNER','sales.create'),('OWNER','sales.post'),('OWNER','sales.discount'),('OWNER','sales.price_override'),('OWNER','sales.override_credit'),
  ('OWNER','receipts.view'),('OWNER','receipts.create'),('OWNER','receipts.void'),
  ('GENERAL_MANAGER','customers.view'),('GENERAL_MANAGER','customers.create'),('GENERAL_MANAGER','customers.edit'),('GENERAL_MANAGER','pricing.view'),('GENERAL_MANAGER','pricing.manage'),
  ('GENERAL_MANAGER','sales.view'),('GENERAL_MANAGER','sales.create'),('GENERAL_MANAGER','sales.post'),('GENERAL_MANAGER','sales.discount'),('GENERAL_MANAGER','sales.price_override'),('GENERAL_MANAGER','sales.override_credit'),
  ('GENERAL_MANAGER','receipts.view'),('GENERAL_MANAGER','receipts.create'),('GENERAL_MANAGER','receipts.void'),
  -- sales
  ('SALES_MANAGER','customers.view'),('SALES_MANAGER','customers.create'),('SALES_MANAGER','customers.edit'),('SALES_MANAGER','pricing.view'),('SALES_MANAGER','pricing.manage'),
  ('SALES_MANAGER','sales.view'),('SALES_MANAGER','sales.create'),('SALES_MANAGER','sales.post'),('SALES_MANAGER','sales.discount'),('SALES_MANAGER','sales.price_override'),('SALES_MANAGER','receipts.view'),
  ('SALES_REP','customers.view'),('SALES_REP','customers.create'),('SALES_REP','pricing.view'),('SALES_REP','sales.view'),('SALES_REP','sales.create'),
  ('CASHIER','customers.view'),('CASHIER','pricing.view'),('CASHIER','sales.view'),('CASHIER','sales.create'),('CASHIER','sales.post'),('CASHIER','receipts.view'),('CASHIER','receipts.create'),
  ('BRANCH_MANAGER','customers.view'),('BRANCH_MANAGER','customers.create'),('BRANCH_MANAGER','customers.edit'),('BRANCH_MANAGER','pricing.view'),
  ('BRANCH_MANAGER','sales.view'),('BRANCH_MANAGER','sales.create'),('BRANCH_MANAGER','sales.post'),('BRANCH_MANAGER','sales.discount'),('BRANCH_MANAGER','receipts.view'),('BRANCH_MANAGER','receipts.create'),
  -- accounts
  ('ACCOUNTS_MANAGER','customers.view'),('ACCOUNTS_MANAGER','customers.edit'),('ACCOUNTS_MANAGER','pricing.view'),('ACCOUNTS_MANAGER','sales.view'),('ACCOUNTS_MANAGER','sales.override_credit'),
  ('ACCOUNTS_MANAGER','receipts.view'),('ACCOUNTS_MANAGER','receipts.create'),('ACCOUNTS_MANAGER','receipts.void'),
  ('ACCOUNTS_OFFICER','customers.view'),('ACCOUNTS_OFFICER','pricing.view'),('ACCOUNTS_OFFICER','sales.view'),('ACCOUNTS_OFFICER','receipts.view'),('ACCOUNTS_OFFICER','receipts.create'),
  -- people who see names and invoices on dispatch documents
  ('WAREHOUSE_MANAGER','customers.view'),('WAREHOUSE_MANAGER','sales.view'),
  ('WAREHOUSE_PICKER','customers.view'),('WAREHOUSE_PICKER','sales.view'),
  ('WAREHOUSE_PACKER','customers.view'),('WAREHOUSE_PACKER','sales.view'),
  ('DISPATCHER','customers.view'),('DISPATCHER','sales.view'),
  ('PHARMACIST','customers.view'),('PHARMACIST','pricing.view'),('PHARMACIST','sales.view'),
  ('AUDITOR','customers.view'),('AUDITOR','pricing.view'),('AUDITOR','sales.view'),('AUDITOR','receipts.view'),
  ('READ_ONLY','customers.view'),('READ_ONLY','pricing.view'),('READ_ONLY','sales.view'),('READ_ONLY','receipts.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id
from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code = m.code
on conflict do nothing;
