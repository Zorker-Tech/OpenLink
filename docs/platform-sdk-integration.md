# OpenLink Cloud SDK integration checkpoint

## Current implementation

The Cloud account controls are now wired into the existing settings page, with
Local omission, truthful verification/pending states and guarded browser actions.
See [Cloud settings](./platform-cloud-settings.md) for the 59-test/full-build
checkpoint and outstanding visual/production acceptance.

Project references now have a deployed RLS/revision schema and BFF source routes;
see [Cloud project references](./platform-cloud-project-links.md). They are not
execution migration. The real test account currently has no visible application
projects, so positive mapping/runtime acceptance remains pending.

Login start/callback source and one-use PKCE transactions now exist; their Cloud
migration and real service smoke passed. See [Cloud login](./platform-cloud-login.md)
for the explicit disabled-by-default release flag and remaining UI/recovery gates.

The durable Cloud token store, refresh coordinator and BFF connection read/exit
routes are now implemented. See [Cloud OAuth storage](./platform-cloud-oauth-storage.md)
for deployed database migrations, server receipt authority, real API evidence and
remaining production BFF/key-provisioning gates. The packed SDK now includes the
host refresh-coordinator hook, strict multi-origin failover pins and bounded
request admission. It is pinned to SHA256
`d1c2d1a55735437f75ccb31bd1d505abedcbd6260c40c532a4b52b149f22a8ce`.

`lib/platform-cloud-sdk.ts` imports the packed `@vtslx/platform-sdk` product and
Auth subpaths. The package is pinned by SHA256 in
`packages/platform-sdk/manifest.json`; the root lockfile consumes its hash-named
tarball. The source SDK remains in AoAPI; no authentication implementation was
copied into OpenLink. Follow that artifact directory's README for build-time
provisioning and integrity verification. The current candidate is
`platform-sdk-0.2.0-d1c2d1a5.tgz`; the previous `62d76c35`, `b6dc745b`, `ef72d9b9`, `ee127c10`, `110555d8`, `5f5c7217`, `23d37284`, `343cb085`, `64448581`, `57f4f1e8`, `5e5b1b2d`, `da13c7ba`, `d0d247f6`, `461ce08b`, `13a956c6`, `f532c29a`, `3248e525`,
`ca62353f`, `dd28b5ba`, `f4260110`, `56ea80bc`, `74fad278`, `cf303846`, `8d574ff8`,
`51560bda`, `4fdda226` and `5f4a3366` archives remain available for rollback.

The adapter rejects Local mode before construction and requires an explicit
user-bound token store and issuer subject. It checks userinfo before directory,
project or Workspace access. Application and cloud project IDs have different
fields and cannot be implicitly interchanged. This layer does not replace the
BFF's required authenticated-user/RLS checks.

## Intended host use

Create the adapter per authenticated Cloud request/connection. Supply a secure
store bound to that connection's ZOKERBASE user and established Hydite subject.
Authorize application project membership before passing an
`AuthorizedCloudProjectBinding`. Call `project(binding)` for public capabilities
or `workspace(binding)` for the Workspace session protocol. Do not cache the
adapter/store globally or accept the binding directly from an untrusted body.

There is deliberately no default Code Plan client: Code Plan is Hydite IDE's
entitlement domain, not an OpenLink account requirement. Local runtime/SSO and
native VM paths are unchanged.

## Verified in this batch

- Packed SDK dependency installed through the root package graph.
- Artifact checksum verified.
- A remote isolated consumer using the packed candidate passed all six Cloud
  adapter identity, project-reference and ordering tests.
- Six adapter tests passed: Local no-network, mandatory identity/store,
  external project mapping, subject mismatch, cross-user binding rejection,
  identity-before-directory ordering.
- Focused adapter TypeScript check passed.
- The underlying Auth SDK's new userinfo method separately passed real-account
  OAuth/PKCE/signature/subject/refresh/replay tests. This is not a Cloud UI test.

Commands:

```sh
node scripts/sync-platform-sdk.mjs --check
node --test scripts/test/platform-cloud-sdk.test.mjs
```

## Not yet integrated / release gates

Visual/production connect-disconnect acceptance, positive project mapping acceptance,
Agent Host/Worker wiring, service cleanup retries and actual browser/runtime
flows are pending. BFF connection routes exist in source but are not deployed;
only the additive Cloud storage/RPC migrations are deployed. Do not present the
Cloud login/runtime migration as complete or remove current flows. Complete
ADR-0023's matrix before accepting the full architectural change.

Retain the previous manifest/lockfile/artifact for an explicit rollback. Missing
artifacts or cloud authorization must fail rather than fetch code at runtime,
invent readiness, share another user's tokens or fall back into Local execution.
