-- Publication is explicit; pre-existing announcements remain internal.
alter table private.platform_announcements add column tenant_visible boolean not null default false;
create table private.announcement_reads (
 announcement_id uuid not null references private.platform_announcements(id),
 user_id uuid not null references auth.users(id), read_at timestamptz not null default now(),
 primary key(announcement_id,user_id)
);
revoke all on private.announcement_reads from public,anon,authenticated;

create function public.platform_publish_announcement(p_id uuid,p_publish boolean,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare a private.platform_announcements;
begin
 perform private.require_platform('support');
 if p_publish is null or p_reason is null or length(btrim(p_reason)) not between 3 and 500 then raise exception 'Publication decision and reason required' using errcode='22023'; end if;
 select * into a from private.platform_announcements where id=p_id for update;
 if not found then raise exception 'Announcement not found' using errcode='P0002'; end if;
 if p_publish and a.expires_at<=now() then raise exception 'Expired announcements cannot be published' using errcode='22023'; end if;
 if a.tenant_visible=p_publish then return; end if;
 update private.platform_announcements set tenant_visible=p_publish where id=p_id;
 insert into private.platform_audit(actor_id,action,target_id,metadata) values(auth.uid(),case when p_publish then 'announcement.published' else 'announcement.withdrawn' end,p_id,jsonb_build_object('reason',btrim(p_reason)));
end $$;

create function public.tenant_announcements(p_page integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; total bigint;
begin
 if private.current_organization_id() is null then raise exception 'Active organization access required' using errcode='42501'; end if;
 if p_page is null or p_page<0 or p_page>100000 then raise exception 'Invalid page' using errcode='22023'; end if;
 select count(*) into total from private.platform_announcements where tenant_visible and published_at<=now() and expires_at>now();
 select coalesce(jsonb_agg(x),'[]') into result from (select a.id,a.title,a.body,a.published_at,a.expires_at,exists(select 1 from private.announcement_reads r where r.announcement_id=a.id and r.user_id=auth.uid()) is_read from private.platform_announcements a where tenant_visible and published_at<=now() and expires_at>now() order by published_at desc,id limit 25 offset p_page*25) x;
 return jsonb_build_object('rows',result,'total',total);
end $$;
create function public.tenant_read_announcement(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if private.current_organization_id() is null then raise exception 'Active organization access required' using errcode='42501'; end if;
 perform 1 from private.platform_announcements where id=p_id and tenant_visible and published_at<=now() and expires_at>now() for share;
 if not found then raise exception 'Announcement not found' using errcode='P0002'; end if;
 insert into private.announcement_reads(announcement_id,user_id) values(p_id,auth.uid()) on conflict do nothing;
end $$;
revoke all on function public.platform_publish_announcement(uuid,boolean,text),public.tenant_announcements(integer),public.tenant_read_announcement(uuid) from public,anon;
grant execute on function public.platform_publish_announcement(uuid,boolean,text),public.tenant_announcements(integer),public.tenant_read_announcement(uuid) to authenticated;
