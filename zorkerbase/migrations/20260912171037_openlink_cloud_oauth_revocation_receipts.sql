-- A user JWT alone cannot attest that the server completed remote revocation.
create table openlink_cloud_private.revocation_keys (
  key_id text primary key check (key_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  secret bytea not null check (octet_length(secret)=32),
  enabled boolean not null default true,
  expires_at timestamptz,
  user_id uuid references auth.users(id) on delete restrict,
  connection_id uuid,
  created_at timestamptz not null default now()
);
alter table openlink_cloud_private.revocation_keys enable row level security;
revoke all on openlink_cloud_private.revocation_keys from public, anon, authenticated;

create function openlink_cloud_private.verified_connection_command(p_operation text,p_connection_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := auth.uid();
  v_row openlink_cloud_private.oauth_connections%rowtype;
  v_key_id text;
  v_signature text;
  v_secret bytea;
  v_expected bytea;
  v_received bytea;
  v_message text;
  v_difference integer := 0;
  v_i integer;
begin
  if v_user is null then raise exception 'Cloud connection authentication required' using errcode='42501'; end if;
  if p_operation='ack_revoke' then
    select * into v_row from openlink_cloud_private.oauth_connections
      where id=p_connection_id and user_id=v_user for update;
    if not found then return jsonb_build_object('outcome','missing'); end if;
    if v_row.state='revoked' then return jsonb_build_object('outcome','revoked'); end if;
    if v_row.state<>'revoking' or v_row.revision is distinct from (p_payload->>'revision')::bigint then
      return jsonb_build_object('outcome','conflict');
    end if;
    v_key_id := p_payload->'receipt'->>'key_id';
    v_signature := p_payload->'receipt'->>'signature';
    if v_key_id is null or v_signature is null or v_signature !~ '^[a-f0-9]{64}$' then
      return jsonb_build_object('outcome','invalid_receipt');
    end if;
    select secret into v_secret from openlink_cloud_private.revocation_keys
      where key_id=v_key_id and enabled and (expires_at is null or expires_at>clock_timestamp())
        and (user_id is null or user_id=v_user) and (connection_id is null or connection_id=p_connection_id)
      for share;
    if not found then return jsonb_build_object('outcome','invalid_receipt'); end if;
    v_message := 'openlink/cloud-revocation/v1' || chr(10) || v_key_id || chr(10) || v_user::text || chr(10)
      || p_connection_id::text || chr(10) || v_row.revision::text;
    v_expected := extensions.hmac(convert_to(v_message,'UTF8'),v_secret,'sha256');
    v_received := decode(v_signature,'hex');
    if v_expected is null or octet_length(v_expected)<>32 then
      return jsonb_build_object('outcome','invalid_receipt');
    end if;
    -- Fixed-length comparison without an early mismatch return.
    for v_i in 0..31 loop
      v_difference := v_difference | (get_byte(v_expected,v_i) # get_byte(v_received,v_i));
    end loop;
    if v_difference<>0 then return jsonb_build_object('outcome','invalid_receipt'); end if;
  end if;
  return openlink_cloud_private.connection_command(p_operation,p_connection_id,p_payload-'receipt');
end;
$$;

create or replace function openlink.cloud_oauth_connection_command(p_operation text,p_connection_id uuid,p_payload jsonb default '{}')
returns jsonb language sql security invoker set search_path='' as $$
  select openlink_cloud_private.verified_connection_command(p_operation,p_connection_id,p_payload);
$$;
-- No legacy direct-call bypass around the attestation check.
revoke all on function openlink_cloud_private.connection_command(text,uuid,jsonb) from authenticated;
revoke all on function openlink_cloud_private.verified_connection_command(text,uuid,jsonb) from public,anon;
grant execute on function openlink_cloud_private.verified_connection_command(text,uuid,jsonb) to authenticated;
revoke all on function openlink.cloud_oauth_connection_command(text,uuid,jsonb) from public,anon;
grant execute on function openlink.cloud_oauth_connection_command(text,uuid,jsonb) to authenticated;

comment on table openlink_cloud_private.revocation_keys is
  'Operator-provisioned server revocation-confirmation keys. Never accessible to BFF user JWTs; no default key. Optional user/connection scope is for bounded canaries.';
notify pgrst, 'reload schema';
