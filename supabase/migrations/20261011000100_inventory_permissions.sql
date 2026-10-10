-- Phase 2 / 01: permissions for inventory
--
-- Inventory is BRANCH-scoped: every stock row belongs to a warehouse, a warehouse belongs to a branch, and a
-- permission only applies to the warehouses of the branches it was granted for (organization-wide grants cover all).

insert into public.permissions (code, module, action, description) values
  ('inventory.view',          'inventory', 'view',          'View stock, batches, expiry and the stock ledger'),
  ('inventory.opening_stock', 'inventory', 'opening_stock', 'Load opening stock balances'),
  ('inventory.adjust',        'inventory', 'adjust',        'Post stock adjustments (count variances, damages, write-offs)'),
  ('inventory.transfer',      'inventory', 'transfer',      'Transfer stock between warehouses'),
  ('inventory.quarantine',    'inventory', 'quarantine',    'Change stock status (quarantine, release, damaged, expired)')
on conflict (code) do update set description = excluded.description;

with matrix(role_code, pattern) as (values
  ('SUPER_ADMIN',         'inventory.%'),
  ('OWNER',               'inventory.%'),
  ('GENERAL_MANAGER',     'inventory.%'),
  ('WAREHOUSE_MANAGER',   'inventory.%'),
  ('BRANCH_MANAGER',      'inventory.view'),     ('BRANCH_MANAGER',      'inventory.transfer'),
  ('PHARMACIST',          'inventory.view'),     ('PHARMACIST',          'inventory.quarantine'),
  ('PROCUREMENT_MANAGER', 'inventory.view'),     ('PROCUREMENT_OFFICER', 'inventory.view'),
  ('WAREHOUSE_PICKER',    'inventory.view'),     ('WAREHOUSE_PACKER',    'inventory.view'),
  ('DISPATCHER',          'inventory.view'),
  ('SALES_MANAGER',       'inventory.view'),     ('SALES_REP',           'inventory.view'),
  ('CASHIER',             'inventory.view'),
  ('ACCOUNTS_MANAGER',    'inventory.view'),     ('ACCOUNTS_OFFICER',    'inventory.view'),
  ('AUDITOR',             'inventory.view'),     ('READ_ONLY',           'inventory.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id
from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code like m.pattern
on conflict do nothing;
