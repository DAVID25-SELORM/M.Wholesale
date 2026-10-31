create function public.platform_subscriptions(p_search text default '',p_page integer default 0,p_filter text default 'ALL') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.require_platform('billing');
 if p_page is null or p_page<0 or p_page>100000 or length(coalesce(p_search,''))>200 or p_filter is null or p_filter not in ('ALL','ACTIVE','TRIAL','CANCELLED','ENDED','ENDING_SOON') then raise exception 'Invalid subscription filter' using errcode='22023'; end if;
 with filtered as (
 select s.*,o.name organization,p.name plan,p.currency,p.monthly_price,p.annual_price,
 (s.status='ACTIVE' and s.ends_on<current_date and o.is_active and o.archived_at is null and p.is_active) can_renew
 from private.platform_subscriptions s join public.organizations o on o.id=s.organization_id join private.platform_plans p on p.id=s.plan_id
 where o.name ilike '%'||coalesce(p_search,'')||'%' and
 (p_filter='ALL' or p_filter=s.status or (p_filter='ENDED' and s.status in ('ACTIVE','TRIAL') and s.ends_on<current_date)
 or (p_filter='ENDING_SOON' and s.status in ('ACTIVE','TRIAL') and s.ends_on between current_date and current_date+30))
 ), paged as (select * from filtered order by ends_on,organization_id limit 25 offset p_page*25)
 select jsonb_build_object('total',(select count(*) from filtered),'rows',coalesce((select jsonb_agg(paged order by ends_on,organization_id) from paged),'[]')) into result;
 return result;
end $$;
revoke all on function public.platform_subscriptions(text,integer,text) from public,anon;
grant execute on function public.platform_subscriptions(text,integer,text) to authenticated;
