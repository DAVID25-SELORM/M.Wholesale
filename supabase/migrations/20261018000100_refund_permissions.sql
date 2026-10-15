-- Phase 9 / 01: permissions for refunds and reversals
--
--   refunds.view         see refunds paid out to customers
--   refunds.create       pay a customer's unused credit back (cash, mobile money, bank transfer ...), branch-scoped
--   sales.reverse        reverse a posted sales invoice (the sale is undone: stock returns, payments become customer credit)
--   credit_notes.reverse reverse a posted credit note (the credit is withdrawn, returned goods are taken back out of stock)
-- Reversals and refunds undo or pay out money, so they sit with owners, general managers and the accounts manager.

insert into public.permissions (code, module, action, description) values
  ('refunds.view',         'refunds',      'view',    'View refunds paid to customers'),
  ('refunds.create',       'refunds',      'create',  'Refund a customer''s unused credit'),
  ('sales.reverse',        'sales',        'reverse', 'Reverse a posted sales invoice'),
  ('credit_notes.reverse', 'credit_notes', 'reverse', 'Reverse a posted credit note')
on conflict (code) do update set description = excluded.description;

with matrix(role_code, code) as (values
  ('SUPER_ADMIN','refunds.view'),('SUPER_ADMIN','refunds.create'),('SUPER_ADMIN','sales.reverse'),('SUPER_ADMIN','credit_notes.reverse'),
  ('OWNER','refunds.view'),('OWNER','refunds.create'),('OWNER','sales.reverse'),('OWNER','credit_notes.reverse'),
  ('GENERAL_MANAGER','refunds.view'),('GENERAL_MANAGER','refunds.create'),('GENERAL_MANAGER','sales.reverse'),('GENERAL_MANAGER','credit_notes.reverse'),
  ('ACCOUNTS_MANAGER','refunds.view'),('ACCOUNTS_MANAGER','refunds.create'),('ACCOUNTS_MANAGER','sales.reverse'),('ACCOUNTS_MANAGER','credit_notes.reverse'),
  ('ACCOUNTS_OFFICER','refunds.view'),
  ('SALES_MANAGER','refunds.view'),('SALES_MANAGER','refunds.create'),
  ('BRANCH_MANAGER','refunds.view'),('BRANCH_MANAGER','refunds.create'),
  ('CASHIER','refunds.view'),
  ('AUDITOR','refunds.view'),
  ('READ_ONLY','refunds.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id
from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code = m.code
on conflict do nothing;
