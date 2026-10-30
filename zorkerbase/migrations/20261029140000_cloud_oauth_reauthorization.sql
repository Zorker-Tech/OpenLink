-- A fresh OAuth grant may replace credentials only for the same user,
-- issuer subject and client, and only from the fenced reauth_required state.
create function openlink_cloud_private.reauthorize_connection(
  p_connection_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_row openlink_cloud_private.oauth_connections%rowtype;
  v_now timestamptz;
  v_expected bigint;
  v_envelope jsonb;
begin
  if v_user is null then
    raise exception 'Cloud connection authentication required' using errcode = '42501';
  end if;
  if p_connection_id is null
    or jsonb_typeof(p_payload) is distinct from 'object'
    or octet_length(p_payload::text) > 70000
    or coalesce(p_payload->>'revision', '') !~ '^[1-9][0-9]{0,15}$' then
    raise exception 'Invalid Cloud reauthorization command' using errcode = '22023';
  end if;

  select * into v_row
    from openlink_cloud_private.oauth_connections
   where id = p_connection_id and user_id = v_user
   for update;
  if not found then
    return jsonb_build_object('outcome', 'missing');
  end if;

  v_now := clock_timestamp();
  v_expected := (p_payload->>'revision')::bigint;
  if v_row.state <> 'reauth_required'
    or v_row.revision <> v_expected
    or v_row.revision >= 9007199254740991 then
    return jsonb_build_object('outcome', 'conflict');
  end if;
  if v_row.subject is distinct from p_payload->>'subject'
    or v_row.client_id is distinct from p_payload->>'client_id' then
    return jsonb_build_object('outcome', 'identity_mismatch');
  end if;

  v_envelope := p_payload->'envelope';
  if jsonb_typeof(v_envelope) is distinct from 'object'
    or v_envelope->>'version' is distinct from '1'
    or not (v_envelope ?& array['ciphertext', 'iv', 'tag', 'keyId']) then
    raise exception 'Encrypted Cloud credentials required' using errcode = '22023';
  end if;

  update openlink_cloud_private.oauth_connections
     set state = 'active',
         revision = revision + 1,
         envelope = v_envelope,
         lease_token = null,
         lease_until = null,
         updated_at = v_now
   where id = p_connection_id
   returning * into v_row;

  return jsonb_build_object(
    'outcome', 'reauthorized',
    'record', to_jsonb(v_row) - 'lease_token'
  );
end;
$$;

create function openlink.cloud_oauth_connection_reauthorize(
  p_connection_id uuid,
  p_payload jsonb
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select openlink_cloud_private.reauthorize_connection(p_connection_id, p_payload);
$$;

revoke all on function openlink_cloud_private.reauthorize_connection(uuid, jsonb) from public, anon;
revoke all on function openlink.cloud_oauth_connection_reauthorize(uuid, jsonb) from public, anon;
grant usage on schema openlink_cloud_private to authenticated;
grant execute on function openlink_cloud_private.reauthorize_connection(uuid, jsonb) to authenticated;
grant execute on function openlink.cloud_oauth_connection_reauthorize(uuid, jsonb) to authenticated;

comment on function openlink_cloud_private.reauthorize_connection(uuid, jsonb) is
  'Atomically installs a fresh OAuth grant only for the same user, subject and client on a reauth_required connection.';

notify pgrst, 'reload schema';
