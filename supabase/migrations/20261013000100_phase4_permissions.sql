-- Phase 4 / 01: permissions for costing, stock counts, purchase returns and supplier invoices (payables)
--
--   inventory.valuation     see what stock cost (batch costs and the valuation report) - sensitive, so separate from inventory.view
--   inventory.count         start counts and enter counted quantities
--   inventory.count_approve approve a count (this posts the variances to stock)
--   payables.view           see supplier invoices, ageing and credits
--   payables.create         record and edit supplier invoices, record supplier credits
--   payables.approve        approve an invoice for payment (after the 3-way match)
--   payables.pay            mark an approved invoice as paid
-- Returning goods to a supplier uses purchasing.receive (the warehouse that holds the stock).

insert into public.permissions (code, module, action, description) values
  ('inventory.valuation',     'inventory', 'valuation',     'See stock cost and the stock valuation report'),
  ('inventory.count',         'inventory', 'count',         'Start stock counts and enter counted quantities'),
  ('inventory.count_approve', 'inventory', 'count_approve', 'Approve stock counts (posts the variances)'),
  ('payables.view',           'payables',  'view',          'View supplier invoices, ageing and credits'),
  ('payables.create',         'payables',  'create',        'Record and edit supplier invoices and credits'),
  ('payables.approve',        'payables',  'approve',       'Approve supplier invoices for payment'),
  ('payables.pay',            'payables',  'pay',           'Mark supplier invoices as paid')
on conflict (code) do update set description = excluded.description;

with matrix(role_code, code) as (values
  ('SUPER_ADMIN', 'inventory.valuation'), ('SUPER_ADMIN', 'inventory.count'), ('SUPER_ADMIN', 'inventory.count_approve'),
  ('OWNER', 'inventory.valuation'), ('OWNER', 'inventory.count'), ('OWNER', 'inventory.count_approve'),
  ('GENERAL_MANAGER', 'inventory.valuation'), ('GENERAL_MANAGER', 'inventory.count'), ('GENERAL_MANAGER', 'inventory.count_approve'),
  ('WAREHOUSE_MANAGER', 'inventory.count'),
  ('WAREHOUSE_PICKER', 'inventory.count'),
  ('PHARMACIST', 'inventory.count'),
  ('BRANCH_MANAGER', 'inventory.count_approve'),
  ('PROCUREMENT_MANAGER', 'inventory.valuation'),
  ('ACCOUNTS_MANAGER', 'inventory.valuation'), ('ACCOUNTS_OFFICER', 'inventory.valuation'),
  ('AUDITOR', 'inventory.valuation'),
  ('SUPER_ADMIN', 'payables.view'), ('SUPER_ADMIN', 'payables.create'), ('SUPER_ADMIN', 'payables.approve'), ('SUPER_ADMIN', 'payables.pay'),
  ('OWNER', 'payables.view'), ('OWNER', 'payables.create'), ('OWNER', 'payables.approve'), ('OWNER', 'payables.pay'),
  ('GENERAL_MANAGER', 'payables.view'), ('GENERAL_MANAGER', 'payables.create'), ('GENERAL_MANAGER', 'payables.approve'), ('GENERAL_MANAGER', 'payables.pay'),
  ('ACCOUNTS_MANAGER', 'payables.view'), ('ACCOUNTS_MANAGER', 'payables.create'), ('ACCOUNTS_MANAGER', 'payables.approve'), ('ACCOUNTS_MANAGER', 'payables.pay'),
  ('ACCOUNTS_OFFICER', 'payables.view'), ('ACCOUNTS_OFFICER', 'payables.create'),
  ('PROCUREMENT_MANAGER', 'payables.view'), ('PROCUREMENT_MANAGER', 'payables.create'),
  ('PROCUREMENT_OFFICER', 'payables.view'), ('PROCUREMENT_OFFICER', 'payables.create'),
  ('AUDITOR', 'payables.view'), ('READ_ONLY', 'payables.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id
from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code = m.code
on conflict do nothing;
