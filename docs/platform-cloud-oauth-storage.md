# Cloud OAuth persistence and refresh coordination

## Architecture

The SDK remains the OAuth protocol implementation. OpenLink supplies two host
adapters: `CloudOAuthVault` is its encrypted token store and refresh coordinator;
`createCloudCredentialCipher` uses server-held AES-256-GCM keys. ZOKERBASE remains
the application identity/data authority. No service-role client is placed in
Next.js, and Local mode rejects this integration before creating a data client.

An authenticated BFF request resolves the application user with `getUser()` and
calls only the user-scoped `openlink.cloud_oauth_connection_command` RPC. Its
public wrapper is security-invoker. Private, search-path-pinned definers enforce
ownership and state transitions. Users cannot directly read or write either
private table, nor call the legacy private mutator around receipt verification.

## State and failure semantics

| State | Meaning | Credential use |
| --- | --- | --- |
| `active` | Stored connected grant | Allowed after identity checks |
| `refreshing` | One database-fenced rotation lease | Current grant may be read; only lease owner can save |
| `reauth_required` | Ambiguous/expired failed refresh | Reconnect, never replay old refresh token |
| `revoking` | Local access fenced; remote cleanup pending | Revocation workflow only |
| `revoked` | Confirmed cleanup; ciphertext destroyed | Denied |

Refresh claim/commit uses row locking, revision comparison, a random lease token
and a 60-second database deadline. An expired refresh lease is **not stolen**:
its external outcome may be unknown. The SDK rereads after acquiring coordination
and reuses a different instance's valid rotated result. Waiting is bounded by 40
attempts and a ten-second monotonic wait budget, plus bounded in-flight database
requests. These are protocol timeouts, not measured availability/RTO guarantees.

The revision identifies the encrypted credential generation. Disconnect removes
the active lease and fences writes through state, but preserves that revision so
the retained bundle can still be authenticated for remote revocation. State and
revision checks reject a late refresh commit after disconnect.

## Encryption and server configuration

Required only for a deployed Cloud BFF:

- `OPENLINK_APP_URL`: configured HTTPS product origin.
- `OPENLINK_CLOUD_OAUTH_CLIENT_ID`: client for new logins; existing sealed client
  bindings remain usable for their own refresh and cleanup.
- `OPENLINK_CLOUD_OAUTH_KEYRING`: JSON with `active` and `keys` mapping key IDs to
  base64-encoded random 32-byte encryption keys.
- `OPENLINK_CLOUD_OAUTH_REVOCATION_KEY`: JSON with `id` and `key` for a separate
  base64-encoded random 32-byte server acknowledgement key.

Provision secrets through the owning deployment/secret-manager boundary, never
`NEXT_PUBLIC_*`, browser storage, repository `.env` files, logs or Local fallback
keys. The encryption envelope includes version, key ID, ciphertext, IV and tag.
Associated data binds key ID, application user, connection UUID, issuer, subject,
OAuth client and credential revision. Changing any binding fails authentication.
Bundles are bounded to 32 KiB before encryption. Old encryption keys must remain
available during a rotation window; new refresh writes use the active key.

The current implementation uses in-process keys, not an HSM or non-exportable KMS
signer. Production Cloud key provisioning is not complete merely because a test
generated an ephemeral key.

## Remote revocation confirmation

An authenticated user can request disconnect but cannot assert that remote
revocation succeeded. Before destroying ciphertext, the RPC verifies a server
HMAC-SHA256 receipt bound to key ID, user UUID, connection UUID and revision.
The canonical UTF-8 message is the newline-separated sequence:

```text
openlink/cloud-revocation/v1
<key_id>
<user_uuid_lowercase>
<connection_uuid_lowercase>
<revision_decimal>
```

No final newline. The signature is lowercase hex. Only trusted server code may
call the signer after the actual OAuth revocation succeeds. Database verification
uses `extensions.hmac` and a fixed-length comparison. Verification keys live in
`openlink_cloud_private.revocation_keys`; no default key is inserted. Keys can be
disabled/expired and optionally scoped to one user/connection for a canary.
Provision the same key securely to the BFF and the private verifier; user JWTs
cannot manage those keys.

The BFF fences locally first, attempts remote revocation, and acknowledges only
after success. Remote failure returns HTTP 202 with `revocationPending: true` and
retains ciphertext. A missing/invalid server receipt never destroys it. Pending
revocation must be retried while retaining its keyring. The autonomous service
cleanup worker is still pending; do not claim eventual cleanup without it.

## BFF contracts implemented in source

- `GET /api/platform/connections`: authenticated user's metadata projection only.
- `GET /api/platform/connections/[connectionId]`: verifies issuer userinfo before
  reporting connected; inactive state is not represented as ready.
- `DELETE /api/platform/connections/[connectionId]`: exact-origin guard,
  authenticated ownership, local fence, remote revoke and server acknowledgement.

All responses are private/no-store and errors are redacted. These routes are not
the login callback: PKCE transaction persistence, connect/callback UI, project
mapping and Agent Host wiring remain separate required work. The BFF code has not
been deployed or browser-accepted by this batch.

## Schema, release and rollback

Applied on the existing Cloud database at `pool.hydite.com`:

| Version | Name | Source SHA256 |
| --- | --- | --- |
| `20260912164449` | `openlink_cloud_oauth_connections` | `60f8cf8a4b37f109e30369979439d3da9c64fa050c0d918653f44c5a06ba6bb6` |
| `20260912171037` | `openlink_cloud_oauth_revocation_receipts` | `146149c1b8e0a70fdc49d08e720910a97aa901d46dadd4dbfaef116197e82196` |

Newly generated source filenames were aligned with the authoritative remote
migration versions, without changing applied SQL bytes. Existing migrations and
user/project/plan data were not rewritten. Future migration changes are append-only.

Do not roll back by enabling the old direct mutator or dropping pending grants.
Disable new connections, keep the private state and cleanup capability, and roll
forward if necessary. Account deletion must first drain remote revocations and
remove finalized connection metadata through the owned deletion workflow: the
foreign key deliberately prevents silent deletion of unresolved grants.

## Verification and boundaries

Twenty-five focused adapter/store/server/route tests and the focused TypeScript
check pass. The database state-machine tests use an in-memory PostgreSQL-compatible
engine; its pgcrypto primitive is replaced with exact Node HMAC vectors because
that engine does not ship pgcrypto. This is explicitly unit evidence. Node and the
real Cloud PostgreSQL pgcrypto matched the public RFC 4231 test vector separately.

Real-account checks against Cloud Auth/PostgREST and public OAuth passed:

- encrypted creation and anonymous rejection;
- two independent SDK instances, one real refresh request, identical result and
  revision 2 (not an OS-process crash/restart drill);
- issuer subject confirmation and two accessible platform projects;
- local disconnect denial, successful remote revocation, rejection of unsigned
  acknowledgement, valid server receipt and ciphertext destruction.

The final live receipt was operator-assisted using a five-minute key scoped to
the exact test account/connection. Its secret never left the database. This is
not production BFF secret provisioning. Both test connections were finalized and
removed, temporary OAuth clients disabled with audit history retained, the scoped
test signing key deleted, and test logins signed out. Readback found zero matching
test connections/keys, no direct authenticated table/key read, and no legacy private
RPC bypass. No Local staging service or database was created.

Developer checks:

```sh
node scripts/sync-platform-sdk.mjs --check
node --test scripts/test/platform-cloud-sdk.test.mjs scripts/test/platform-cloud-routes.test.mjs scripts/test/platform-cloud-connection.test.mjs
OPENLINK_PGLITE_MODULE=/path/to/pinned/pglite/dist/index.js node --test scripts/test/platform-cloud-vault.test.mjs
```

`scripts/live-platform-cloud-vault-smoke.mjs` is an operator smoke, receives login
and the final scoped receipt through hidden stdin, and reports cleanup IDs. It
must not replace an existing active user connection or print credential material.
