-- Phase 3 / 01: permissions for purchasing
--
-- Purchasing is BRANCH-scoped: a purchase order belongs to the branch of the warehouse it delivers to, and a
-- permission only applies to orders of the branches it was granted for (organization-wide grants cover all).
-- Separation of duties: the person who prepares an order is not the person who approves it (see the migration).

insert into public.permissions (code, module, action, description) values
  ('purchasing.view',    'purchasing', 'view',    'View purchase orders and goods received'),
  ('purchasing.create',  'purchasing', 'create',  'Create, edit and submit purchase orders'),
  ('purchasing.approve', 'purchasing', 'approve', 'Approve, reject, cancel and close purchase orders'),
  ('purchasing.receive', 'purchasing', 'receive', 'Receive goods against approved purchase orders')
on conflict (code) do update set description = excluded.description;

with matrix(role_code, pattern) as (values
  ('SUPER_ADMIN',         'purchasing.%'),
  ('OWNER',               'purchasing.%'),
  ('GENERAL_MANAGER',     'purchasing.%'),
  ('PROCUREMENT_MANAGER', 'purchasing.view'),  ('PROCUREMENT_MANAGER', 'purchasing.create'),
  ('PROCUREMENT_MANAGER', 'purchasing.approve'),
  ('PROCUREMENT_OFFICER', 'purchasing.view'),  ('PROCUREMENT_OFFICER', 'purchasing.create'),
  ('WAREHOUSE_MANAGER',   'purchasing.view'),  ('WAREHOUSE_MANAGER',   'purchasing.receive'),
  ('BRANCH_MANAGER',      'purchasing.view'),  ('BRANCH_MANAGER',      'purchasing.create'),
  ('PHARMACIST',          'purchasing.view'),
  ('ACCOUNTS_MANAGER',    'purchasing.view'),  ('ACCOUNTS_OFFICER',    'purchasing.view'),
  ('AUDITOR',             'purchasing.view'),  ('READ_ONLY',           'purchasing.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id
from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code like m.pattern
on conflict do nothing;
