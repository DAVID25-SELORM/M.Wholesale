-- Support operators can discover assignable colleagues without operator-management access.
create function public.platform_support_assignees() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform private.require_platform('support');
 return (select coalesce(jsonb_agg(jsonb_build_object('id',o.user_id,'email',u.email) order by u.email),'[]')
 from private.platform_operators o join auth.users u on u.id=o.user_id
 where o.is_active and 'support'=any(o.permissions) and nullif(to_jsonb(u)->>'email_confirmed_at','') is not null);
end $$;
revoke all on function public.platform_support_assignees() from public,anon;
grant execute on function public.platform_support_assignees() to authenticated;

create function private.validate_support_assignment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' then
 if new.assigned_to is not distinct from old.assigned_to then return new; end if;
 end if;
 if new.assigned_to is not null then
 perform 1 from private.platform_operators o join auth.users u on u.id=o.user_id
 where o.user_id=new.assigned_to and o.is_active and 'support'=any(o.permissions)
 and nullif(to_jsonb(u)->>'email_confirmed_at','') is not null for share of o;
 if not found then raise exception 'Choose an active verified administrator with support permission' using errcode='22023'; end if;
 end if;
 return new;
end $$;
revoke all on function private.validate_support_assignment() from public,anon,authenticated;
create trigger support_assignment_validate before insert or update of assigned_to on private.platform_tickets for each row execute function private.validate_support_assignment();

create function private.audit_support_assignment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.assigned_to is distinct from old.assigned_to then
 insert into private.platform_audit(actor_id,organization_id,action,target_id,metadata)
 values(auth.uid(),new.organization_id,'ticket.assigned',new.id,jsonb_build_object('previous_assignee',old.assigned_to,'assignee',new.assigned_to));
 end if;
 return new;
end $$;
revoke all on function private.audit_support_assignment() from public,anon,authenticated;
create trigger support_assignment_audit after update of assigned_to on private.platform_tickets for each row execute function private.audit_support_assignment();
