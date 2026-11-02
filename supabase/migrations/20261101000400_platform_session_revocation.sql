-- Revoke ERP/API access for existing Auth sessions, including refreshed JWTs.
-- Auth session creation time, not token issuance time, determines eligibility.
create table private.session_revocations (
 user_id uuid primary key references auth.users(id), revoked_before timestamptz not null,
 revoked_by uuid not null references auth.users(id), reason text not null
);
revoke all on private.session_revocations from public,anon,authenticated;
create function private.session_access_allowed() returns boolean
language plpgsql stable security definer set search_path='' as $$
declare cutoff timestamptz; session_id uuid; allowed boolean;
begin
 select revoked_before into cutoff from private.session_revocations where user_id=auth.uid();
 if not found then return true; end if;
 if to_regclass('auth.sessions') is null then return false; end if;
 begin session_id:=(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'session_id')::uuid; exception when invalid_text_representation then return false; end;
 if session_id is null then return false; end if;
 execute 'select exists(select 1 from auth.sessions where id=$1 and user_id=$2 and created_at>$3)' into allowed using session_id,auth.uid(),cutoff;
 return allowed;
end $$;
revoke all on function private.session_access_allowed() from public,anon,authenticated;

do $$ declare d text; begin
 d:=pg_get_functiondef('private.current_organization_id()'::regprocedure);
 if position('and private.trial_access_allowed(o.id)' in d)=0 then raise exception 'Unexpected organization access definition'; end if;
 execute replace(d,'and private.trial_access_allowed(o.id)','and private.trial_access_allowed(o.id) and private.session_access_allowed()');
 d:=pg_get_functiondef('private.is_platform_operator()'::regprocedure);
 if position('o.user_id=auth.uid()' in d)=0 then raise exception 'Unexpected platform access definition'; end if;
 execute replace(d,'o.user_id=auth.uid()','o.user_id=auth.uid() and private.session_access_allowed()');
 d:=pg_get_functiondef('public.get_session_context()'::regprocedure);
 if position('when not v_profile.is_active' in d)=0 then raise exception 'Unexpected session context definition'; end if;
 execute replace(d,'when not v_profile.is_active','when not private.session_access_allowed() then ''session_revoked''
    when not v_profile.is_active');
end $$;

create function public.platform_revoke_sessions(p_user uuid,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare org uuid;
begin
 perform private.require_platform('users');
 if p_user=auth.uid() then raise exception 'Another administrator must revoke your sessions' using errcode='42501'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 5 and 500 then raise exception 'Give a revocation reason (5 to 500 characters)' using errcode='22023'; end if;
 if to_regclass('auth.sessions') is null then raise exception 'Auth session service unavailable' using errcode='55000'; end if;
 perform 1 from auth.users where id=p_user for update;
 if not found then raise exception 'User not found' using errcode='P0002'; end if;
 if exists(select 1 from private.platform_operators where user_id=p_user) then perform private.require_platform('operators'); end if;
 select organization_id into org from public.profiles where id=p_user;
 insert into private.session_revocations(user_id,revoked_before,revoked_by,reason) values(p_user,clock_timestamp(),auth.uid(),btrim(p_reason))
 on conflict(user_id) do update set revoked_before=excluded.revoked_before,revoked_by=excluded.revoked_by,reason=excluded.reason;
 insert into private.platform_audit(actor_id,organization_id,action,target_id,metadata) values(auth.uid(),org,'user.erp_sessions_revoked',p_user,jsonb_build_object('reason',btrim(p_reason)));
end $$;
revoke all on function public.platform_revoke_sessions(uuid,text) from public,anon;
grant execute on function public.platform_revoke_sessions(uuid,text) to authenticated;

create function public.platform_user_sessions(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare sessions jsonb:='[]'; events jsonb:='[]'; cutoff timestamptz;
begin
 perform private.require_platform('users');
 if exists(select 1 from private.platform_operators where user_id=p_user) then perform private.require_platform('operators'); end if;
 if not exists(select 1 from auth.users where id=p_user) then raise exception 'User not found' using errcode='P0002'; end if;
 select revoked_before into cutoff from private.session_revocations where user_id=p_user;
 if to_regclass('auth.sessions') is not null then
  execute 'select coalesce(jsonb_agg(x),''[]'') from (select id,created_at,to_jsonb(s)->>''updated_at'' updated_at,(created_at<=$2) revoked from auth.sessions s where user_id=$1 order by created_at desc,id limit 100) x' into sessions using p_user,cutoff;
 end if;
 if to_regclass('auth.audit_log_entries') is not null then
  execute 'select coalesce(jsonb_agg(x),''[]'') from (select id,created_at,payload->>''action'' action from auth.audit_log_entries where payload->>''actor_id''=$1 order by created_at desc,id limit 100) x' into events using p_user::text;
 end if;
 return jsonb_build_object('sessions',sessions,'events',events,'revoked_before',cutoff,'sessions_available',to_regclass('auth.sessions') is not null,'history_available',to_regclass('auth.audit_log_entries') is not null);
end $$;
revoke all on function public.platform_user_sessions(uuid) from public,anon;
grant execute on function public.platform_user_sessions(uuid) to authenticated;
