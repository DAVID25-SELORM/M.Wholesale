-- Phase 0 / 09: permissions and system roles (reference data, idempotent)
--
-- Permission codes are stable identifiers: <module>.<action>. Later phases ADD rows
-- (products.*, inventory.*, orders.*, credit.*, payments.* ...) in their own migrations.
--
-- SUPER_ADMIN: an ORGANIZATION-level technical administrator (every permission inside
-- its own organization). It is not a cross-tenant role: no RLS policy anywhere grants
-- access outside private.current_organization_id(). Platform-level operations
-- (creating organizations, support) run server-side with the service-role key, which
-- never reaches a browser, via public.provision_*().

insert into public.permissions (code, module, action, description) values
  ('organizations.view',         'organizations',        'view',   'View organization profile'),
  ('organizations.manage',       'organizations',        'manage', 'Edit organization profile'),
  ('branches.view',              'branches',             'view',   'View branch administration'),
  ('branches.create',            'branches',             'create', 'Create branches'),
  ('branches.edit',              'branches',             'edit',   'Edit and (de)activate branches'),
  ('warehouses.view',            'warehouses',           'view',   'View warehouses'),
  ('warehouses.create',          'warehouses',           'create', 'Create warehouses'),
  ('warehouses.edit',            'warehouses',           'edit',   'Edit and (de)activate warehouses'),
  ('warehouse_locations.view',   'warehouse_locations',  'view',   'View warehouse locations'),
  ('warehouse_locations.create', 'warehouse_locations',  'create', 'Create warehouse locations'),
  ('warehouse_locations.edit',   'warehouse_locations',  'edit',   'Edit and (de)activate warehouse locations'),
  ('users.view',                 'users',                'view',   'View users'),
  ('users.invite',               'users',                'invite', 'Invite new users'),
  ('users.edit',                 'users',                'edit',   'Edit user profiles'),
  ('users.deactivate',           'users',                'deactivate', 'Activate / deactivate users'),
  ('roles.view',                 'roles',                'view',   'View roles and permission matrix'),
  ('roles.assign',               'roles',                'assign', 'Assign and revoke roles for users'),
  ('roles.manage',               'roles',                'manage', 'Administer roles and permissions (administrator)'),
  ('audit.view',                 'audit',                'view',   'View the audit log'),
  ('settings.view',              'settings',             'view',   'View system settings'),
  ('settings.manage',            'settings',             'manage', 'Change system settings')
on conflict (code) do update set description = excluded.description;

insert into public.roles (organization_id, code, name, description, is_system_role) values
  (null, 'SUPER_ADMIN',         'Super Administrator',  'Organization technical administrator: all permissions inside the organization', true),
  (null, 'OWNER',               'Owner',                'Business owner: all permissions', true),
  (null, 'GENERAL_MANAGER',     'General Manager',      'Runs the business; cannot administer roles or the company profile', true),
  (null, 'BRANCH_MANAGER',      'Branch Manager',       'Manages a branch (assign with branch scope)', true),
  (null, 'PHARMACIST',          'Pharmacist',           'Superintendent / dispensing pharmacist', true),
  (null, 'PROCUREMENT_MANAGER', 'Procurement Manager',  'Leads purchasing', true),
  (null, 'PROCUREMENT_OFFICER', 'Procurement Officer',  'Raises and follows up purchases', true),
  (null, 'WAREHOUSE_MANAGER',   'Warehouse Manager',    'Runs warehouse operations', true),
  (null, 'WAREHOUSE_PICKER',    'Warehouse Picker',     'Picks stock', true),
  (null, 'WAREHOUSE_PACKER',    'Warehouse Packer',     'Packs orders', true),
  (null, 'SALES_MANAGER',       'Sales Manager',        'Leads sales', true),
  (null, 'SALES_REP',           'Sales Representative', 'Field / counter sales', true),
  (null, 'ACCOUNTS_MANAGER',    'Accounts Manager',     'Leads finance', true),
  (null, 'ACCOUNTS_OFFICER',    'Accounts Officer',     'Finance operations', true),
  (null, 'CREDIT_CONTROLLER',   'Credit Controller',    'Customer credit and collections', true),
  (null, 'CASHIER',             'Cashier',              'Receives payments', true),
  (null, 'DISPATCHER',          'Dispatcher',           'Plans dispatch', true),
  (null, 'DRIVER',              'Driver',               'Delivers goods', true),
  (null, 'AUDITOR',             'Auditor',              'Read-only access including the audit log', true),
  (null, 'READ_ONLY',           'Read Only',            'Basic read-only access', true)
on conflict (organization_id, code) do update
  set name = excluded.name, description = excluded.description;

-- Role -> permission matrix. Every pattern is a SQL LIKE against permission codes;
-- "exclude" rows win over "include" rows.
with matrix(role_code, kind, pattern) as (values
  ('SUPER_ADMIN',         'include', '%'),
  ('OWNER',               'include', '%'),
  ('GENERAL_MANAGER',     'include', '%'),
  ('GENERAL_MANAGER',     'exclude', 'roles.manage'),
  ('GENERAL_MANAGER',     'exclude', 'organizations.manage'),
  ('BRANCH_MANAGER',      'include', 'organizations.view'),
  ('BRANCH_MANAGER',      'include', 'branches.view'),
  ('BRANCH_MANAGER',      'include', 'branches.edit'),
  ('BRANCH_MANAGER',      'include', 'warehouses.%'),
  ('BRANCH_MANAGER',      'include', 'warehouse_locations.%'),
  ('BRANCH_MANAGER',      'include', 'users.view'),
  ('BRANCH_MANAGER',      'include', 'roles.view'),
  ('BRANCH_MANAGER',      'include', 'audit.view'),
  ('BRANCH_MANAGER',      'include', 'settings.view'),
  ('WAREHOUSE_MANAGER',   'include', 'organizations.view'),
  ('WAREHOUSE_MANAGER',   'include', 'branches.view'),
  ('WAREHOUSE_MANAGER',   'include', 'warehouses.view'),
  ('WAREHOUSE_MANAGER',   'include', 'warehouses.edit'),
  ('WAREHOUSE_MANAGER',   'include', 'warehouse_locations.%'),
  ('AUDITOR',             'include', '%.view'),
  ('READ_ONLY',           'include', 'organizations.view'),
  ('READ_ONLY',           'include', 'branches.view'),
  ('READ_ONLY',           'include', 'warehouses.view'),
  ('READ_ONLY',           'include', 'warehouse_locations.view'),
  -- operational roles: basic visibility of the structure they work in
  ('PHARMACIST',          'include', 'organizations.view'),
  ('PHARMACIST',          'include', 'branches.view'),
  ('PHARMACIST',          'include', 'warehouses.view'),
  ('PROCUREMENT_MANAGER', 'include', 'organizations.view'),
  ('PROCUREMENT_MANAGER', 'include', 'branches.view'),
  ('PROCUREMENT_MANAGER', 'include', 'warehouses.view'),
  ('PROCUREMENT_OFFICER', 'include', 'organizations.view'),
  ('PROCUREMENT_OFFICER', 'include', 'branches.view'),
  ('PROCUREMENT_OFFICER', 'include', 'warehouses.view'),
  ('WAREHOUSE_PICKER',    'include', 'branches.view'),
  ('WAREHOUSE_PICKER',    'include', 'warehouses.view'),
  ('WAREHOUSE_PICKER',    'include', 'warehouse_locations.view'),
  ('WAREHOUSE_PACKER',    'include', 'branches.view'),
  ('WAREHOUSE_PACKER',    'include', 'warehouses.view'),
  ('WAREHOUSE_PACKER',    'include', 'warehouse_locations.view'),
  ('SALES_MANAGER',       'include', 'organizations.view'),
  ('SALES_MANAGER',       'include', 'branches.view'),
  ('SALES_MANAGER',       'include', 'warehouses.view'),
  ('SALES_REP',           'include', 'branches.view'),
  ('ACCOUNTS_MANAGER',    'include', 'organizations.view'),
  ('ACCOUNTS_MANAGER',    'include', 'branches.view'),
  ('ACCOUNTS_OFFICER',    'include', 'branches.view'),
  ('CREDIT_CONTROLLER',   'include', 'branches.view'),
  ('CASHIER',             'include', 'branches.view'),
  ('DISPATCHER',          'include', 'branches.view'),
  ('DISPATCHER',          'include', 'warehouses.view'),
  ('DRIVER',              'include', 'branches.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id
from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code like m.pattern
where m.kind = 'include'
  and not exists (
    select 1 from matrix x
    where x.role_code = m.role_code and x.kind = 'exclude' and pm.code like x.pattern
  )
on conflict do nothing;
