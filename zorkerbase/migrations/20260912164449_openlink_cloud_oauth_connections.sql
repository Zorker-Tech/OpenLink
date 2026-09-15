-- Cloud OAuth only. No changes to Local identities or existing application data.
create schema if not exists openlink_cloud_private;

create table openlink_cloud_private.oauth_connections (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete restrict,
  issuer text not null check (issuer = 'https://auth.hydite.com'),
  subject text not null check (length(subject) between 1 and 255),
  client_id text not null check (length(client_id) between 1 and 255),
  revision bigint not null default 1 check (revision between 1 and 9007199254740991),
  state text not null default 'active' check (state in ('active','refreshing','reauth_required','revoking','revoked')),
  envelope jsonb,
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((state = 'revoked') = (envelope is null)),
  check (envelope is null or (jsonb_typeof(envelope) = 'object' and octet_length(envelope::text) <= 65536)),
  check ((state = 'refreshing') = (lease_token is not null and lease_until is not null))
);
create unique index oauth_connections_one_current_identity
  on openlink_cloud_private.oauth_connections(user_id, issuer)
  where state in ('active','refreshing','reauth_required');
create index oauth_connections_pending_revocation
  on openlink_cloud_private.oauth_connections(updated_at) where state = 'revoking';
alter table openlink_cloud_private.oauth_connections enable row level security;
create policy oauth_connections_owner on openlink_cloud_private.oauth_connections
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on openlink_cloud_private.oauth_connections from public, anon, authenticated;

-- Only this private definer mutates the state machine. The exposed RPC is invoker.
create function openlink_cloud_private.connection_command(p_operation text, p_connection_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_row openlink_cloud_private.oauth_connections%rowtype;
  v_now timestamptz;
  v_expected bigint;
  v_lease uuid;
  v_envelope jsonb;
begin
  if v_user is null then raise exception 'Cloud connection authentication required' using errcode = '42501'; end if;
  if jsonb_typeof(p_payload) is distinct from 'object'
    or octet_length(p_payload::text) > 70000 then
    raise exception 'Invalid Cloud connection command' using errcode = '22023';
  end if;
  if p_operation = 'list' then
    return jsonb_build_object('outcome','listed','connections',coalesce((
      select jsonb_agg(jsonb_build_object('id',id,'issuer',issuer,'subject',subject,'client_id',client_id,
        'state',state,'updated_at',updated_at) order by updated_at desc)
      from openlink_cloud_private.oauth_connections where user_id=v_user
    ),'[]'::jsonb));
  end if;
  if p_connection_id is null then raise exception 'Cloud connection ID required' using errcode='22023'; end if;
  if p_operation = 'create' then
    v_envelope := p_payload->'envelope';
    if jsonb_typeof(v_envelope) is distinct from 'object' or v_envelope->>'version' is distinct from '1'
      or not (v_envelope ?& array['ciphertext','iv','tag','keyId']) then
      raise exception 'Encrypted Cloud credentials required' using errcode = '22023';
    end if;
    insert into openlink_cloud_private.oauth_connections(id,user_id,issuer,subject,client_id,envelope)
    values(p_connection_id,v_user,p_payload->>'issuer',p_payload->>'subject',p_payload->>'client_id',v_envelope)
    returning * into v_row;
    return jsonb_build_object('outcome','created','record',to_jsonb(v_row)-'lease_token');
  end if;

  select * into v_row from openlink_cloud_private.oauth_connections
   where id = p_connection_id and user_id = v_user for update;
  if not found then return jsonb_build_object('outcome','missing'); end if;
  v_now := clock_timestamp(); -- after lock acquisition, not before a possible wait

  -- An expired refresh is uncertain: never give a new actor the consumed credential.
  if v_row.state = 'refreshing' and v_row.lease_until <= v_now then
    update openlink_cloud_private.oauth_connections
       set state='reauth_required', lease_token=null, lease_until=null, updated_at=v_now
     where id=p_connection_id returning * into v_row;
  end if;
  if p_operation = 'load' then
    return jsonb_build_object('outcome','loaded','record',to_jsonb(v_row)-'lease_token');
  elsif p_operation = 'disconnect' then
    if v_row.state not in ('revoking','revoked') then
      update openlink_cloud_private.oauth_connections
         set state='revoking', lease_token=null, lease_until=null, updated_at=v_now
       where id=p_connection_id returning * into v_row;
    end if;
    -- Keep the encrypted credential until remote revocation is acknowledged.
    return jsonb_build_object('outcome','disconnected','record',to_jsonb(v_row)-'lease_token');
  elsif p_operation = 'ack_revoke' then
    if v_row.state='revoking' and v_row.revision=(p_payload->>'revision')::bigint then
      update openlink_cloud_private.oauth_connections
         set state='revoked', envelope=null, updated_at=v_now
       where id=p_connection_id returning * into v_row;
    end if;
    return jsonb_build_object('outcome',case when v_row.state='revoked' then 'revoked' else 'conflict' end);
  end if;

  if v_row.state not in ('active','refreshing') then
    return jsonb_build_object('outcome','reauth_required');
  end if;
  v_expected := (p_payload->>'revision')::bigint;
  if v_expected is null then raise exception 'Cloud revision is required' using errcode='22023'; end if;
  if p_operation='claim' then
    if v_row.revision<>v_expected then
      return jsonb_build_object('outcome','changed','record',to_jsonb(v_row)-'lease_token');
    elsif v_row.state='refreshing' then
      return jsonb_build_object('outcome','busy','record',to_jsonb(v_row)-'lease_token');
    end if;
    update openlink_cloud_private.oauth_connections
       set state='refreshing', lease_token=gen_random_uuid(), lease_until=v_now+interval '60 seconds', updated_at=v_now
     where id=p_connection_id returning * into v_row;
    return jsonb_build_object('outcome','claimed','lease',v_row.lease_token,'record',to_jsonb(v_row)-'lease_token');
  end if;

  v_lease := (p_payload->>'lease')::uuid;
  if v_row.state<>'refreshing' or v_row.revision<>v_expected or v_lease is distinct from v_row.lease_token then
    return jsonb_build_object('outcome','conflict');
  end if;
  if p_operation='commit' then
    v_envelope := p_payload->'envelope';
    if jsonb_typeof(v_envelope) is distinct from 'object' or v_envelope->>'version' is distinct from '1'
      or not (v_envelope ?& array['ciphertext','iv','tag','keyId']) then
      raise exception 'Encrypted Cloud credentials required' using errcode='22023';
    end if;
    update openlink_cloud_private.oauth_connections
       set state='active', revision=revision+1, envelope=v_envelope, lease_token=null, lease_until=null, updated_at=v_now
     where id=p_connection_id returning * into v_row;
    return jsonb_build_object('outcome','committed','record',to_jsonb(v_row)-'lease_token');
  elsif p_operation='release' then
    update openlink_cloud_private.oauth_connections
       set state='active', lease_token=null, lease_until=null, updated_at=v_now
     where id=p_connection_id returning * into v_row;
    return jsonb_build_object('outcome','released','record',to_jsonb(v_row)-'lease_token');
  elsif p_operation='fail' then
    update openlink_cloud_private.oauth_connections
       set state='reauth_required', lease_token=null, lease_until=null, updated_at=v_now
     where id=p_connection_id;
    return jsonb_build_object('outcome','reauth_required');
  end if;
  raise exception 'Unknown Cloud connection command' using errcode='22023';
end;
$$;

create function openlink.cloud_oauth_connection_command(p_operation text, p_connection_id uuid, p_payload jsonb default '{}')
returns jsonb language sql security invoker set search_path = '' as $$
  select openlink_cloud_private.connection_command(p_operation,p_connection_id,p_payload);
$$;
revoke all on function openlink_cloud_private.connection_command(text,uuid,jsonb) from public, anon;
revoke all on function openlink.cloud_oauth_connection_command(text,uuid,jsonb) from public, anon;
grant usage on schema openlink_cloud_private to authenticated;
grant execute on function openlink_cloud_private.connection_command(text,uuid,jsonb) to authenticated;
grant execute on function openlink.cloud_oauth_connection_command(text,uuid,jsonb) to authenticated;

comment on table openlink_cloud_private.oauth_connections is
  'Server-encrypted Cloud OAuth state. No plaintext tokens. Expired refresh leases require reauthentication; revocation retains ciphertext until acknowledged.';
notify pgrst, 'reload schema';
