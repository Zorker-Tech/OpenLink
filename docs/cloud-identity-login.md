# Cloud Hydite identity login

Cloud mode signs users in with their Hydite platform identity. The browser
starts a PKCE flow through the VTSLX Platform SDK. OpenLink validates the
callback and sends the opaque ID token to Supabase Auth, which verifies the
issuer, signature, audience and nonce before creating a native Supabase
session. Application pages and RLS therefore continue to use the shared
`pool.hydite.com` Supabase project.

Local mode keeps its existing email and password login.

## Configure the shared Supabase project

In the Supabase Auth provider settings for `pool.hydite.com`, add and enable a
custom OIDC provider with:

- Provider identifier: `custom:hydite`
- Issuer: `https://auth.hydite.com`
- Client ID: the value of `OPENLINK_CLOUD_OAUTH_CLIENT_ID`
- The provider's Client ID or acceptable client IDs must include that exact
  value, which is also the ID token's `aud` claim.
- Scopes: `openid profile email`
- Email optional: disabled, because Supabase user creation needs the Hydite
  email claim

The provider form requires a client secret. This OpenLink flow submits a
Hydite-issued ID token directly to Supabase Auth, so the secret is not sent to
Hydite. Use a newly generated random placeholder for this field; do not reuse
the Cloud encryption keyring or revocation key.

OpenLink keeps a random raw nonce in its encrypted login cookie and sends its
SHA-256 hex digest to Hydite as the OIDC nonce. When Hydite includes that
digest in the signed ID token, OpenLink passes the raw nonce to Supabase Auth
for validation. The current Hydite ID token omits the nonce claim, so OpenLink
omits the nonce argument to Supabase as well; the callback remains bound by
OAuth state and PKCE.

Set `OPENLINK_CLOUD_SUPABASE_AUTH_PROVIDER=custom:hydite` in `.env.cloud`.
The same provider identifier must exist in Supabase Auth.

## Configure the Hydite OAuth client

The Hydite client ID in `OPENLINK_CLOUD_OAUTH_CLIENT_ID` must allow this exact
redirect URI:

```text
${OPENLINK_APP_URL}/auth/platform/callback
```

For the current Cloud development server, `OPENLINK_APP_URL` is
`http://192.168.3.5:3001`. Cloud development HTTP is allowed only when
`OPENLINK_CLOUD_INSECURE_HTTP_ORIGIN` matches it exactly. Production must use
HTTPS. This exact Cloud development origin is passed to the VTSLX SDK's OAuth
redirect validator only while running in development with both origin values
matching. The client must allow the `openid`, `profile` and `email` scopes and
PKCE with `S256`.

After changing `.env.cloud`, restart Cloud mode so Next.js and the callback
route load the updated settings:

```sh
pnpm dev:cloud
```
