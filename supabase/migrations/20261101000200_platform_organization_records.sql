-- Organization detail records have independent permission checks and explicit fields.
create function public.platform_organization_records(p_organization uuid,p_section text,p_page integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare rows jsonb; total bigint;
begin
 perform private.require_platform('organizations');
 if p_section in ('invoices','payments') then perform private.require_platform('billing');
 elsif p_section='security' then perform private.require_platform('users');
 elsif p_section='settings' then perform private.require_platform('settings');
 else raise exception 'Invalid organization section' using errcode='22023'; end if;
 if p_page is null or p_page<0 or p_page>100000 then raise exception 'Invalid page' using errcode='22023'; end if;
 if not exists(select 1 from public.organizations where id=p_organization) then raise exception 'Organization not found' using errcode='P0002'; end if;
 if p_section='invoices' then
 select count(*) into total from private.platform_invoices where organization_id=p_organization;
 select coalesce(jsonb_agg(x),'[]') into rows from (select id,period_start,period_end,currency,amount,status,created_at from private.platform_invoices where organization_id=p_organization order by created_at desc,id limit 25 offset p_page*25) x;
 elsif p_section='payments' then
 select count(*) into total from private.platform_payments p join private.platform_invoices i on i.id=p.invoice_id where i.organization_id=p_organization;
 select coalesce(jsonb_agg(x),'[]') into rows from (select p.id,p.invoice_id,p.provider,p.amount,p.currency,p.verified_at from private.platform_payments p join private.platform_invoices i on i.id=p.invoice_id where i.organization_id=p_organization order by p.verified_at desc,p.id limit 25 offset p_page*25) x;
 elsif p_section='security' then
 select count(*) into total from public.profiles where organization_id=p_organization;
 select coalesce(jsonb_agg(x),'[]') into rows from (select p.id,p.email,p.is_active,(nullif(to_jsonb(u)->>'email_confirmed_at','') is not null) email_verified,to_jsonb(u)->>'last_sign_in_at' as last_sign_in_at from public.profiles p join auth.users u on u.id=p.id where p.organization_id=p_organization order by p.email,p.id limit 25 offset p_page*25) x;
 else
 select count(*) into total from public.system_settings where organization_id=p_organization;
 select coalesce(jsonb_agg(x),'[]') into rows from (select id,branch_id,category,key,updated_at from public.system_settings where organization_id=p_organization order by category,key,id limit 25 offset p_page*25) x;
 end if;
 return jsonb_build_object('rows',rows,'total',total);
end $$;
revoke all on function public.platform_organization_records(uuid,text,integer) from public,anon;
grant execute on function public.platform_organization_records(uuid,text,integer) to authenticated;
