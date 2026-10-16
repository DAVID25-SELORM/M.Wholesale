-- Phase 13 / 01: permissions for the accounting ledger and bank reconciliation
--
--   accounting.view    see the chart of accounts, journals, trial balance, profit and loss, balance sheet, account ledgers and the control checks
--   accounting.manage  edit the chart of accounts, start accounting (go-live date and opening balances), lock a closed period
--   journals.create    post and reverse manual journals
--   bank.view          see bank accounts, imported statements and reconciliations
--   bank.reconcile     add bank accounts, import statements, match, book bank charges and interest, finish a reconciliation

insert into public.permissions (code, module, action, description) values
  ('accounting.view',   'accounting', 'view',      'View the ledger, journals and financial statements'),
  ('accounting.manage', 'accounting', 'manage',    'Manage the chart of accounts, opening balances and period lock'),
  ('journals.create',   'journals',   'create',    'Post and reverse manual journals'),
  ('bank.view',         'bank',       'view',      'View bank accounts, statements and reconciliations'),
  ('bank.reconcile',    'bank',       'reconcile', 'Import statements and reconcile bank accounts')
on conflict (code) do update set description = excluded.description;

-- Separation of duties: the accounts officer prepares bank reconciliations but cannot post journals; only the accounts manager (and the owner roles) can do both.
with matrix(role_code, code) as (values
  ('SUPER_ADMIN','accounting.view'),('SUPER_ADMIN','accounting.manage'),('SUPER_ADMIN','journals.create'),('SUPER_ADMIN','bank.view'),('SUPER_ADMIN','bank.reconcile'),
  ('OWNER','accounting.view'),('OWNER','accounting.manage'),('OWNER','journals.create'),('OWNER','bank.view'),('OWNER','bank.reconcile'),
  ('GENERAL_MANAGER','accounting.view'),('GENERAL_MANAGER','accounting.manage'),('GENERAL_MANAGER','bank.view'),
  ('ACCOUNTS_MANAGER','accounting.view'),('ACCOUNTS_MANAGER','accounting.manage'),('ACCOUNTS_MANAGER','journals.create'),('ACCOUNTS_MANAGER','bank.view'),('ACCOUNTS_MANAGER','bank.reconcile'),
  ('ACCOUNTS_OFFICER','accounting.view'),('ACCOUNTS_OFFICER','bank.view'),('ACCOUNTS_OFFICER','bank.reconcile'),
  ('AUDITOR','accounting.view'),('AUDITOR','bank.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id
from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code = m.code
on conflict do nothing;
