-- Existing platform-only conversations remain private.
alter table private.platform_tickets add column tenant_visible boolean not null default false;
alter table private.platform_ticket_replies add column tenant_visible boolean not null default false;

create function public.tenant_support_read(p_id uuid default null,p_page integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare org uuid:=private.current_organization_id(); result jsonb; total bigint;
begin
 if org is null then raise exception 'Active organization access required' using errcode='42501'; end if;
 if p_page is null or p_page<0 or p_page>100000 then raise exception 'Invalid page' using errcode='22023'; end if;
 if p_id is not null then
 select jsonb_build_object('id',t.id,'subject',t.subject,'body',t.body,'status',t.status,'priority',t.priority,'created_at',t.created_at) into result from private.platform_tickets t where id=p_id and organization_id=org and tenant_visible and (created_by=auth.uid() or private.has_permission('organizations.manage'));
 if result is null then raise exception 'Ticket not found' using errcode='P0002'; end if;
 return jsonb_build_object('ticket',result,'replies',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'body',r.body,'created_at',r.created_at,'author',case when r.created_by=auth.uid() then 'You' when exists(select 1 from public.profiles p where p.id=r.created_by and p.organization_id=org) then 'Organization member' else 'Platform support' end) order by r.created_at,r.id),'[]') from private.platform_ticket_replies r where ticket_id=p_id and tenant_visible));
 end if;
 select count(*) into total from private.platform_tickets where organization_id=org and tenant_visible and (created_by=auth.uid() or private.has_permission('organizations.manage'));
 select coalesce(jsonb_agg(x),'[]') into result from (select id,subject,status,priority,created_at,updated_at from private.platform_tickets where organization_id=org and tenant_visible and (created_by=auth.uid() or private.has_permission('organizations.manage')) order by updated_at desc,id limit 25 offset p_page*25) x;
 return jsonb_build_object('rows',result,'total',total);
end $$;

create function public.tenant_support_write(p_action text,p_id uuid,p_subject text default null,p_body text default null,p_priority text default 'NORMAL') returns uuid
language plpgsql security definer set search_path='' as $$
declare org uuid:=private.current_organization_id(); t private.platform_tickets; result uuid;
begin
 if org is null then raise exception 'Active organization access required' using errcode='42501'; end if;
 if p_action='CREATE' then
 if p_id is null then raise exception 'Request reference required' using errcode='22023'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_id::text,2));
 select * into t from private.platform_tickets where id=p_id;
 if found then
 if t.organization_id=org and t.created_by=auth.uid() and t.tenant_visible and t.subject=btrim(p_subject) and t.body=btrim(p_body) and t.priority=p_priority then return t.id; end if;
 raise exception 'Request reference already used' using errcode='22023'; end if;
 insert into private.platform_tickets(id,organization_id,subject,body,priority,created_by,tenant_visible) values(p_id,org,btrim(p_subject),btrim(p_body),p_priority,auth.uid(),true) returning id into result;
 elsif p_action in ('REPLY','CLOSE','REOPEN') then
 select * into t from private.platform_tickets where id=p_id and organization_id=org and tenant_visible and (created_by=auth.uid() or private.has_permission('organizations.manage')) for update;
 if not found then raise exception 'Ticket not found' using errcode='P0002'; end if;
 result:=t.id;
 if p_action='REPLY' then
 if t.status='CLOSED' then raise exception 'Reopen this ticket before replying' using errcode='22023'; end if;
 insert into private.platform_ticket_replies(ticket_id,body,created_by,tenant_visible) values(t.id,btrim(p_body),auth.uid(),true);
 end if;
 update private.platform_tickets set status=case p_action when 'CLOSE' then 'CLOSED' when 'REOPEN' then 'OPEN' else status end,updated_at=now() where id=t.id;
 else raise exception 'Invalid support action' using errcode='22023'; end if;
 insert into private.platform_audit(actor_id,organization_id,action,target_id) values(auth.uid(),org,'tenant_support.'||lower(p_action),result);
 return result;
end $$;

create function public.platform_reply_to_tenant(p_id uuid,p_body text) returns uuid
language plpgsql security definer set search_path='' as $$
declare t private.platform_tickets; result uuid;
begin
 perform private.require_platform('support');
 select * into t from private.platform_tickets where id=p_id and tenant_visible for update;
 if not found then raise exception 'Tenant-visible ticket not found' using errcode='P0002'; end if;
 if t.status='CLOSED' then raise exception 'Reopen ticket before replying' using errcode='22023'; end if;
 insert into private.platform_ticket_replies(ticket_id,body,created_by,tenant_visible) values(t.id,btrim(p_body),auth.uid(),true) returning id into result;
 update private.platform_tickets set updated_at=now() where id=t.id;
 insert into private.platform_audit(actor_id,organization_id,action,target_id) values(auth.uid(),t.organization_id,'ticket.tenant_reply',t.id);
 return result;
end $$;
revoke all on function public.tenant_support_read(uuid,integer),public.tenant_support_write(text,uuid,text,text,text),public.platform_reply_to_tenant(uuid,text) from public,anon;
grant execute on function public.tenant_support_read(uuid,integer),public.tenant_support_write(text,uuid,text,text,text),public.platform_reply_to_tenant(uuid,text) to authenticated;
