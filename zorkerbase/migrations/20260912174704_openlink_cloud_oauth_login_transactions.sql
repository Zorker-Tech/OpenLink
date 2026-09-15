create table openlink_cloud_private.login_transactions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null unique,
  client_id text not null check(length(client_id) between 1 and 255),
  redirect_uri text not null check(length(redirect_uri) between 1 and 2048),
  state_hash text not null check(state_hash ~ '^[a-f0-9]{64}$'),
  envelope jsonb,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((consumed_at is null) = (envelope is not null)),
  check (envelope is null or (jsonb_typeof(envelope)='object' and octet_length(envelope::text)<=12000))
);
create index login_transactions_owner_expiry on openlink_cloud_private.login_transactions(user_id,expires_at);
alter table openlink_cloud_private.login_transactions enable row level security;
create policy login_transactions_owner on openlink_cloud_private.login_transactions
  using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
revoke all on openlink_cloud_private.login_transactions from public,anon,authenticated;

create function openlink_cloud_private.login_command(p_operation text,p_login_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := auth.uid();
  v_row openlink_cloud_private.login_transactions%rowtype;
  v_now timestamptz;
begin
  if v_user is null then raise exception 'Cloud login authentication required' using errcode='42501'; end if;
  if p_login_id is null or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>14000 then
    raise exception 'Invalid Cloud login command' using errcode='22023';
  end if;
  if p_operation='begin' then
    perform pg_advisory_xact_lock(hashtextextended(v_user::text||':cloud-logins',0));
    v_now := clock_timestamp();
    delete from openlink_cloud_private.login_transactions where user_id=v_user and expires_at<=v_now;
    -- Count consumed attempts too, so consumption cannot bypass the start budget.
    if (select count(*) from openlink_cloud_private.login_transactions where user_id=v_user and expires_at>v_now)>=8 then
      return jsonb_build_object('outcome','rate_limited');
    end if;
    if jsonb_typeof(p_payload->'envelope') is distinct from 'object' or p_payload->'envelope'->>'version' is distinct from '1' then
      raise exception 'Encrypted PKCE transaction required' using errcode='22023';
    end if;
    insert into openlink_cloud_private.login_transactions(id,user_id,connection_id,client_id,redirect_uri,state_hash,envelope,expires_at)
    values(p_login_id,v_user,(p_payload->>'connection_id')::uuid,p_payload->>'client_id',p_payload->>'redirect_uri',
      p_payload->>'state_hash',p_payload->'envelope',v_now+interval '5 minutes') returning * into v_row;
    return jsonb_build_object('outcome','created','record',to_jsonb(v_row)-'envelope'-'state_hash');
  elsif p_operation='consume' then
    select * into v_row from openlink_cloud_private.login_transactions where id=p_login_id and user_id=v_user for update;
    if not found then return jsonb_build_object('outcome','invalid'); end if;
    if v_row.consumed_at is not null or v_row.expires_at<=clock_timestamp()
      or v_row.state_hash is distinct from p_payload->>'state_hash' then
      return jsonb_build_object('outcome','invalid');
    end if;
    update openlink_cloud_private.login_transactions set consumed_at=clock_timestamp(),envelope=null where id=p_login_id;
    -- Only the winner sees the verifier envelope; it is erased from storage now.
    return jsonb_build_object('outcome','consumed','record',to_jsonb(v_row)-'state_hash');
  end if;
  raise exception 'Unknown Cloud login command' using errcode='22023';
end;
$$;
create function openlink.cloud_oauth_login_command(p_operation text,p_login_id uuid,p_payload jsonb default '{}')
returns jsonb language sql security invoker set search_path='' as $$
  select openlink_cloud_private.login_command(p_operation,p_login_id,p_payload);
$$;
revoke all on function openlink_cloud_private.login_command(text,uuid,jsonb) from public,anon;
revoke all on function openlink.cloud_oauth_login_command(text,uuid,jsonb) from public,anon;
grant execute on function openlink_cloud_private.login_command(text,uuid,jsonb) to authenticated;
grant execute on function openlink.cloud_oauth_login_command(text,uuid,jsonb) to authenticated;
notify pgrst, 'reload schema';
