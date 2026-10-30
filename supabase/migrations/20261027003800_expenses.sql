insert into public.permissions(code,module,action,description) values ('expenses.approve','expenses','approve','Independently approve and post expenses') on conflict do nothing;
insert into public.role_permissions(role_id,permission_id) select r.id,p.id from public.roles r cross join public.permissions p where r.organization_id is null and r.code in ('SUPER_ADMIN','OWNER','GENERAL_MANAGER','ACCOUNTS_MANAGER') and p.code='expenses.approve' on conflict do nothing;
create table public.expenses (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null default private.current_organization_id() references public.organizations(id),
 branch_id uuid not null, expense_date date not null, payee text not null check(length(btrim(payee)) between 2 and 200),
 description text not null check(length(btrim(description)) between 3 and 1000), reference text not null check(length(btrim(reference)) between 1 and 100),
 expense_account_id uuid not null, credit_account_id uuid not null, amount numeric(18,2) not null check(amount>0 and amount<1000000000000),
 status text not null default 'SUBMITTED' check(status in ('SUBMITTED','POSTED','REJECTED','CANCELLED')), journal_id uuid,
 requested_by uuid not null default auth.uid(), decided_by uuid, decision_note text, created_at timestamptz not null default now(),
 unique(id,organization_id), unique(organization_id,branch_id,payee,reference),
 foreign key(branch_id,organization_id) references public.branches(id,organization_id),
 foreign key(expense_account_id,organization_id) references public.gl_accounts(id,organization_id),
 foreign key(credit_account_id,organization_id) references public.gl_accounts(id,organization_id),
 foreign key(journal_id,organization_id) references public.gl_journals(id,organization_id)
);
alter table public.expenses enable row level security;
revoke all on public.expenses from public,anon,authenticated;
grant select on public.expenses to authenticated;
create policy expenses_read on public.expenses for select to authenticated using(organization_id=(select private.current_organization_id()) and private.has_permission('accounting.view',branch_id));
create trigger expenses_audit after insert or update on public.expenses for each row execute function private.audit_row_change('expense');
create trigger expenses_no_delete before delete on public.expenses for each row execute function private.stock_block_mutation();
create function public.submit_expense(p_branch uuid,p_date date,p_payee text,p_description text,p_reference text,p_expense_account uuid,p_credit_account uuid,p_amount numeric) returns uuid
language plpgsql security definer set search_path='' as $$
declare org uuid:=private.current_organization_id(); result uuid;
begin
 if not private.has_permission('journals.create',p_branch) then raise exception 'Journal creation permission required' using errcode='42501'; end if;
 if not exists(select 1 from public.branches where id=p_branch and organization_id=org and is_active) then raise exception 'Active branch not found' using errcode='22023'; end if;
 if p_date is null or p_date>current_date then raise exception 'Expense date cannot be in the future' using errcode='22023'; end if;
 if p_amount is null or p_amount<=0 or p_amount>=1000000000000 or p_amount<>round(p_amount,2) or p_amount='NaN'::numeric then raise exception 'Invalid expense amount' using errcode='22023'; end if;
 if not exists(select 1 from public.gl_accounts where id=p_expense_account and organization_id=org and account_type='EXPENSE' and is_active and allow_manual) then raise exception 'Choose an active expense account permitting manual entries' using errcode='22023'; end if;
 if not exists(select 1 from public.gl_accounts where id=p_credit_account and organization_id=org and account_type in ('ASSET','LIABILITY') and is_active and allow_manual) then raise exception 'Choose an active asset or liability account permitting manual entries' using errcode='22023'; end if;
 insert into public.expenses(branch_id,expense_date,payee,description,reference,expense_account_id,credit_account_id,amount) values(p_branch,p_date,btrim(p_payee),btrim(p_description),btrim(p_reference),p_expense_account,p_credit_account,p_amount) returning id into result;
 return result;
end $$;
create function public.decide_expense(p_id uuid,p_action text,p_note text) returns uuid
language plpgsql security definer set search_path='' as $$
declare e public.expenses; result uuid;
begin
 select * into e from public.expenses where id=p_id and organization_id=private.current_organization_id() for update;
 if not found then raise exception 'Expense not found' using errcode='P0002'; end if;
 if p_note is null or length(btrim(p_note)) not between 3 and 500 then raise exception 'Decision note required' using errcode='22023'; end if;
 if p_action='CANCEL' then
  if e.requested_by<>auth.uid() or not private.has_permission('journals.create',e.branch_id) then raise exception 'Only the requester may cancel' using errcode='42501'; end if;
 elsif p_action in ('APPROVE','REJECT') then
  if e.requested_by=auth.uid() or not private.has_permission('expenses.approve',e.branch_id) then raise exception 'Independent expense approver required' using errcode='42501'; end if;
 else raise exception 'Invalid expense decision' using errcode='22023'; end if;
 if e.status='POSTED' and p_action='APPROVE' then return e.journal_id; end if;
 if e.status<>'SUBMITTED' then raise exception 'Only submitted expenses can be decided' using errcode='22023'; end if;
 if p_action='APPROVE' then
  result:=public.post_manual_journal(e.expense_date,e.payee||': '||e.description,jsonb_build_array(jsonb_build_object('account_id',e.expense_account_id,'debit',e.amount,'credit',0,'memo',e.reference),jsonb_build_object('account_id',e.credit_account_id,'debit',0,'credit',e.amount,'memo',e.reference)),e.branch_id,p_note);
 end if;
 update public.expenses set status=case p_action when 'APPROVE' then 'POSTED' when 'REJECT' then 'REJECTED' else 'CANCELLED' end,journal_id=result,decided_by=auth.uid(),decision_note=btrim(p_note) where id=e.id;
 return result;
end $$;
revoke all on function public.submit_expense(uuid,date,text,text,text,uuid,uuid,numeric),public.decide_expense(uuid,text,text) from public,anon;
grant execute on function public.submit_expense(uuid,date,text,text,text,uuid,uuid,numeric),public.decide_expense(uuid,text,text) to authenticated;
