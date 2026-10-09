-- Phase 1 / 01: permissions for the product catalogue and suppliers
--
-- Catalogue and supplier data are ORGANIZATION-level master data:
--   read  = permission in ANY scope (branch staff need to see products to work),
--   write = permission ORGANIZATION-WIDE (a branch-scoped role cannot change shared master data).

insert into public.permissions (code, module, action, description) values
  ('products.view',    'products',  'view',   'View the product catalogue (products, identities, units, barcodes, aliases)'),
  ('products.create',  'products',  'create', 'Create products and catalogue records'),
  ('products.edit',    'products',  'edit',   'Edit and (de)activate catalogue records'),
  ('suppliers.view',   'suppliers', 'view',   'View suppliers and supplier prices'),
  ('suppliers.create', 'suppliers', 'create', 'Create suppliers'),
  ('suppliers.edit',   'suppliers', 'edit',   'Edit and (de)activate suppliers and supplier prices')
on conflict (code) do update set description = excluded.description;

with matrix(role_code, pattern) as (values
  ('SUPER_ADMIN',         'products.%'),  ('SUPER_ADMIN',         'suppliers.%'),
  ('OWNER',               'products.%'),  ('OWNER',               'suppliers.%'),
  ('GENERAL_MANAGER',     'products.%'),  ('GENERAL_MANAGER',     'suppliers.%'),
  ('PROCUREMENT_MANAGER', 'products.%'),  ('PROCUREMENT_MANAGER', 'suppliers.%'),
  ('PROCUREMENT_OFFICER', 'products.view'),  ('PROCUREMENT_OFFICER', 'products.create'),
  ('PROCUREMENT_OFFICER', 'suppliers.view'), ('PROCUREMENT_OFFICER', 'suppliers.create'),
  ('PROCUREMENT_OFFICER', 'suppliers.edit'),
  ('PHARMACIST',          'products.view'),  ('PHARMACIST',          'products.edit'),
  ('PHARMACIST',          'suppliers.view'),
  ('BRANCH_MANAGER',      'products.view'),  ('BRANCH_MANAGER',      'suppliers.view'),
  ('WAREHOUSE_MANAGER',   'products.view'),  ('WAREHOUSE_MANAGER',   'suppliers.view'),
  ('WAREHOUSE_PICKER',    'products.view'),  ('WAREHOUSE_PACKER',    'products.view'),
  ('SALES_MANAGER',       'products.view'),  ('SALES_REP',           'products.view'),
  ('CASHIER',             'products.view'),  ('DISPATCHER',          'products.view'),
  ('ACCOUNTS_MANAGER',    'products.view'),  ('ACCOUNTS_MANAGER',    'suppliers.view'),
  ('ACCOUNTS_OFFICER',    'products.view'),  ('ACCOUNTS_OFFICER',    'suppliers.view'),
  ('AUDITOR',             'products.view'),  ('AUDITOR',             'suppliers.view'),
  ('READ_ONLY',           'products.view'),  ('READ_ONLY',           'suppliers.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id
from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code like m.pattern
on conflict do nothing;
