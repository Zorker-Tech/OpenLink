# ADR-0028: Separate Cloud and Local source-checkout startup profiles

## Status

Proposed. Root commands and the environment contract are implemented, and the
user confirmed that `pool.hydite.com` is the `supabase-us` endpoint. End-to-end
acceptance against Studio and its VTSLX OAuth registration remains required.

## Context

The root supervisor resolves `OPENLINK_RUNTIME_MODE` before Next.js starts.
Local is the default and injects its own ZOKERBASE URL and publishable key into
the Web/BFF. Next.js loads its standard `.env*` files later, but that is too
late to select which services the supervisor starts. Reusing the Local
environment file for a Cloud run can therefore start the wrong identity domain
or compile the wrong public Supabase configuration.

The root `--mode` flag already distinguishes development from production. It
cannot also identify the Local/Cloud data profile without making lifecycle
mode ambiguous. Studio must remain the engineering surface for the same hosted
Supabase project that owns OpenLink Cloud data. The VTSLX SDK uses its
registered OAuth client ID for this integration.

## Decision

- Keep `--mode development|production` as the lifecycle selector and add
  `--profile local|cloud` as the runtime identity/data selector.
- Add `pnpm dev:cloud` and `pnpm start:cloud`. They load the ignored
  `.env.cloud` before importing the supervisor and select the Cloud profile.
- Cloud startup requires `OPENLINK_CLOUD_SUPABASE_URL` and
  `OPENLINK_CLOUD_SUPABASE_PUBLISHABLE_KEY`. The supervisor sets the existing
  `NEXT_PUBLIC_SUPABASE_*` compatibility values to the same project so server
  and browser clients cannot drift. They must identify the `supabase-us`
  project also used by Studio. A service-role key must never be exposed to the
  browser.
- The Cloud profile uses the same `OPENLINK_CLOUD_OAUTH_CLIENT_ID` registered
  for Studio with the existing VTSLX SDK and trusted issuer. OAuth keyring and
  revocation keys remain server-only.
- Cloud end-user authentication uses the Hydite identity from that same VTSLX
  client. OpenLink exchanges the ID token with the shared Supabase Auth project
  through its `custom:hydite` OIDC provider, producing a native Supabase
  session for existing server checks and RLS policies. The Cloud Auth provider
  setup and redirect registration are documented in
  [`docs/cloud-identity-login.md`](../../cloud-identity-login.md).
- LAN browser testing may opt into HTTP by setting
  `OPENLINK_CLOUD_INSECURE_HTTP_ORIGIN` to the exact `OPENLINK_APP_URL` origin.
  This is accepted only in development and uses a development-only OAuth state
  cookie name. The exact origin is allowlisted in the VTSLX SDK's redirect
  validator only for this opt-in; production still requires HTTPS.
- Local remains independent and continues to use its generated local
  ZOKERBASE identity/database. Cloud configuration is not copied into Local
  storage, and Cloud startup never falls back to Local ZOKERBASE.
- The Cloud source-checkout supervisor starts the Next.js Web/BFF and a
  loopback Cloud SDK Host. The SDK Host accepts only authenticated BFF requests,
  verifies the Hydite subject, and makes user-scoped VTSLX Computer API calls
  with a short-lived access token. It has no arbitrary command endpoint and
  does not initialize local Podman, Chromium, Agent Host, Browser Host, Studio
  origin proxy, Project VM, ZOKERBASE, or Zero.
- Existing Cloud Agent/Knowledge integrations use explicit `OPENLINK_CLOUD_*`
  variables. The supervisor maps them into server-side compatibility variables
  after clearing Local values. Provider credentials use a separate Cloud
  encryption key; a multi-instance deployment must set a shared
  `OPENLINK_CLOUD_PROVIDER_SECRET_KEY`.
- Local service initialization belongs to the explicitly selected Local
  profile (`pnpm dev:local` or `pnpm start` with the Local profile).

## Consequences

The Cloud profile has a separate, explicit configuration file and starts
against hosted identity/application data without bootstrapping local runtime
services. Its writes affect the same database observed in Studio.
Cloud configuration failures stop startup before services are launched.
Developers must keep `.env.cloud` out of version control and use only a
publishable key for browser access. The SDK client ID and Cloud OAuth keyring
must be provisioned from the Studio integration; those secrets are not
available from the checked-in environment sample.

## Alternatives Considered

- Reuse `.env.local` and rely on Next.js to load it: rejected because the root
  supervisor selects and injects mode-specific services before Next.js loads
  its environment files.
- Overload `--mode` with `cloud`: rejected because lifecycle mode and data
  profile are independent dimensions.
- Add a Cloud-only database or SDK issuer: rejected because Studio and
  OpenLink Cloud must share the application database and trusted VTSLX issuer.

## Migration and rollback

Existing `dev`, `dev:local`, `start`, and deployment environment contracts
remain available. If the Cloud profile is not used, remove the two Cloud
package scripts and profile handling; Local startup and stored data are
unaffected. No database migration or data copy is introduced.

## Failure and security

The Cloud entry point fails before Web starts when its required
Supabase URL or publishable key is absent. It never retries against Local
identity/data. The publishable key is the only Supabase key passed to Web
clients; OAuth encryption/revocation material and the SDK Host token remain
server-side. The shared database retains its existing Auth, RLS, and Studio
access controls.

## Verification

Source-level syntax and configuration checks are required first. End-to-end
acceptance must confirm that a Cloud session reads/writes the intended
`supabase-us` project, Studio observes the same rows, Local still uses an
independent ZOKERBASE, the SDK Host reaches only the caller's linked VTSLX
Computer, and the VTSLX SDK authenticates with Studio's registered client ID
and trusted issuer. Chat execution still needs a Cloud Agent Host that
implements OpenLink's streaming agent contract; the SDK Host does not serve as
that runtime.
