-- Phase 7 / 01: permissions for credit notes (sales returns)
--
--   credit_notes.view      see credit notes
--   credit_notes.create    draft and cancel credit notes (branch of the warehouse the goods come back to)
--   credit_notes.post      post a credit note (the customer owes less, returned goods re-enter stock) and apply unused credit to invoices
--   credit_notes.restock   put returned goods straight back into SELLABLE stock (anything else comes back as quarantine / damaged for inspection)
-- Posting a credit note is a financial act, so it is a separate right from drafting one.

insert into public.permissions (code, module, action, description) values
  ('credit_notes.view',    'credit_notes', 'view',    'View credit notes and sales returns'),
  ('credit_notes.create',  'credit_notes', 'create',  'Draft and cancel credit notes'),
  ('credit_notes.post',    'credit_notes', 'post',    'Post credit notes and apply customer credit to invoices'),
  ('credit_notes.restock', 'credit_notes', 'restock', 'Return goods straight to sellable stock')
on conflict (code) do update set description = excluded.description;

with matrix(role_code, code) as (values
  ('SUPER_ADMIN','credit_notes.view'),('SUPER_ADMIN','credit_notes.create'),('SUPER_ADMIN','credit_notes.post'),('SUPER_ADMIN','credit_notes.restock'),
  ('OWNER','credit_notes.view'),('OWNER','credit_notes.create'),('OWNER','credit_notes.post'),('OWNER','credit_notes.restock'),
  ('GENERAL_MANAGER','credit_notes.view'),('GENERAL_MANAGER','credit_notes.create'),('GENERAL_MANAGER','credit_notes.post'),('GENERAL_MANAGER','credit_notes.restock'),
  ('SALES_MANAGER','credit_notes.view'),('SALES_MANAGER','credit_notes.create'),('SALES_MANAGER','credit_notes.post'),
  ('BRANCH_MANAGER','credit_notes.view'),('BRANCH_MANAGER','credit_notes.create'),('BRANCH_MANAGER','credit_notes.post'),
  ('SALES_REP','credit_notes.view'),('SALES_REP','credit_notes.create'),
  ('CASHIER','credit_notes.view'),('CASHIER','credit_notes.create'),
  ('ACCOUNTS_MANAGER','credit_notes.view'),('ACCOUNTS_MANAGER','credit_notes.post'),
  ('ACCOUNTS_OFFICER','credit_notes.view'),
  ('WAREHOUSE_MANAGER','credit_notes.view'),('WAREHOUSE_MANAGER','credit_notes.create'),('WAREHOUSE_MANAGER','credit_notes.restock'),
  ('PHARMACIST','credit_notes.view'),('PHARMACIST','credit_notes.restock'),
  ('AUDITOR','credit_notes.view'),
  ('READ_ONLY','credit_notes.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id
from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code = m.code
on conflict do nothing;
