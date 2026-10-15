-- Phase 8 / 01: permissions for the point of sale
--
--   pos.sell     ring up sales at the counter and open / close your OWN till session (branch-scoped)
--   pos.view     see every till session and counter sale of the branch (not only your own)
--   pos.manage   close somebody else's till session (for example a cashier who went home without closing)
-- A counter sale is an ordinary sales invoice, so everything the invoice rules require still applies to the cashier: discounts need
-- sales.discount, selling at another price needs sales.price_override, and taking money needs receipts.create.

insert into public.permissions (code, module, action, description) values
  ('pos.sell',   'pos', 'sell',   'Sell at the counter and run your own till session'),
  ('pos.view',   'pos', 'view',   'View all till sessions and counter sales of the branch'),
  ('pos.manage', 'pos', 'manage', 'Close another cashier''s till session')
on conflict (code) do update set description = excluded.description;

with matrix(role_code, code) as (values
  ('SUPER_ADMIN','pos.sell'),('SUPER_ADMIN','pos.view'),('SUPER_ADMIN','pos.manage'),
  ('OWNER','pos.sell'),('OWNER','pos.view'),('OWNER','pos.manage'),
  ('GENERAL_MANAGER','pos.sell'),('GENERAL_MANAGER','pos.view'),('GENERAL_MANAGER','pos.manage'),
  ('SALES_MANAGER','pos.sell'),('SALES_MANAGER','pos.view'),('SALES_MANAGER','pos.manage'),
  ('BRANCH_MANAGER','pos.sell'),('BRANCH_MANAGER','pos.view'),('BRANCH_MANAGER','pos.manage'),
  ('CASHIER','pos.sell'),
  ('ACCOUNTS_MANAGER','pos.view'),
  ('ACCOUNTS_OFFICER','pos.view'),
  ('AUDITOR','pos.view'),
  ('READ_ONLY','pos.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id
from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code = m.code
on conflict do nothing;
