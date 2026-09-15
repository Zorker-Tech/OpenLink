# Cloud login and callback

## Implemented contracts

`POST /api/platform/connections/start` is the Cloud-only login entry point. It
requires the configured product Origin, an authenticated ZOKERBASE application
user and explicit `OPENLINK_CLOUD_OAUTH_LOGIN_ENABLED=true`. It refuses to replace
an active/refreshing/reauthentication-required connection implicitly. The user
must disconnect that connection through its existing workflow first.

The response contains only `authorizationUrl`; the BFF sets a five-minute
`__Host-openlink-cloud-oauth` cookie with Secure, HttpOnly, SameSite=Lax and root
path, without Domain. The UI should navigate to the returned URL after an
explicit user action. Do not dynamically register clients on each login.

`GET /auth/platform/callback` rejects missing/mismatched/duplicate state cookies
and parameters. It authenticates the current application user again, consumes
the database transaction once, authenticates its encrypted PKCE envelope, and
uses the SDK to exchange the code and fetch issuer userinfo. The resulting
issuer subject is explicitly linked to that application user; it is not derived
from email matching or an unverified JWT.

After successful durable connection creation, the route redirects with 303 to
the configured origin's `/settings?cloud=connected&connectionId=...`. It ignores
arbitrary `next` destinations. Denial returns to settings as cancelled. Errors
are redacted and never redirect as connected. Matching callback state cookies
are cleared, and responses use private/no-store plus no-referrer headers.

## Transaction storage and authority

The applied migration is
`20260912174704_openlink_cloud_oauth_login_transactions.sql`, source SHA256
`bf9c2550c5f153f8a9834d1ad53f5fd3f98faf09da70d5d16dccfe3abf5a6d4f`.
The generated source filename was aligned with the authoritative remote version
without changing the applied SQL bytes.

Transactions live in `openlink_cloud_private.login_transactions`. User JWTs
cannot read that table directly. The exposed command is security-invoker and
delegates to a private, ownership-checking definer. Every transaction binds:

- application user, random login UUID and random connection UUID;
- OAuth client and exact callback URI;
- SHA256 of random OAuth state;
- encrypted state/verifier payload and five-minute database expiry.

PKCE encryption has a different authenticated-data domain from token storage:
`openlink/cloud-login/v1`. Envelopes cannot be moved between users, transactions,
connections, clients, callback URLs or token-store purposes. Verifier envelopes
are erased atomically when consumed, before any external code exchange.

Start is serialized per user and limited to eight attempts per five-minute
window, including already-consumed attempts. Expired transactions for that user
are reclaimed on the next start. A replay, expiry or current-user mismatch cannot
recover the verifier or invoke token exchange. No Local identity/data flow changes.

## Recovery and release gates

A lost connection-create acknowledgement can be recovered by reading and
authenticating that exact persisted connection, without repeating code exchange.
Otherwise the host fences any created connection and attempts remote revocation.
Unconfirmed recovery is an explicit `CLOUD_LOGIN_RECOVERY_REQUIRED`, not success.

The durable service recovery queue for simultaneous persistence and revocation
failure remains required. Do not enable the login flag as a substitute for that
work or call this a completed T0 login system. Production key custody, the BFF
deployment, settings UI and actual browser acceptance also remain gates. Keep the
flag unset/false until their readiness review; it was not enabled by this batch.

See [Cloud OAuth storage](./platform-cloud-oauth-storage.md) for keyrings, signed
revocation acknowledgement, refresh coordination, account deletion and cleanup.
Retain the data/RPC migration on rollback so outstanding transactions can expire
safely. Disable new starts before rolling back application code. Redact OAuth
callback query strings in deployment access logs as well as application logs.

## Verification

Thirty-six focused Cloud tests and targeted TypeScript checks passed, including
real NextResponse Cookie/redirect serialization, state/owner/replay/expiry denial,
cancel without exchange, cross-purpose encryption rejection and storage-failure
revocation. The local database engine checks logic only.

`scripts/live-platform-cloud-vault-smoke.mjs --login-transaction` passed against
the real Cloud Auth/PostgREST and Hydite OAuth services: database PKCE consumption,
actual code exchange and userinfo, encrypted connection creation, replay denial,
two-instance refresh with one remote request, directory access, remote revoke,
unsigned receipt denial, signed acknowledgement and ciphertext destruction.
The callback Request/Cookie was supplied by the harness, not a browser. This
does not prove hosted BFF delivery or a completed UI login.

The exact test connection and consumed login were removed after cleanup, its
OAuth client disabled with audit history retained, its scoped signing key deleted
and the test application login signed out. No local staging service was created.
