# ADR-0023: Cloud product SDK and explicit identity/project bindings

## Status

The basic Cloud settings control is implemented and bundled, while Local omits
it. DOM/page tests and a full Web build passed; visual/browser and production
acceptance are still open. See [`platform-cloud-settings.md`](../platform-cloud-settings.md).

Proposed; package and adapter implementation in progress. This is not acceptance
of Cloud login, runtime integration or production migration.

Login start/callback code and one-use encrypted PKCE transactions are now
implemented; the additive Cloud migration and callback-core real-service smoke
passed. Hosted BFF/browser acceptance and the durable grant recovery queue remain
open, so the login release flag is still disabled by default. See
[`platform-cloud-login.md`](../platform-cloud-login.md).

Update: encrypted Cloud persistence, database-fenced refresh and server-attested
revocation are implemented, and their two additive Cloud migrations and real
API smoke passed. BFF read/disconnect routes exist in source. See
[`platform-cloud-oauth-storage.md`](../platform-cloud-oauth-storage.md). Callback,
UI, project mapping, service cleanup and runtime acceptance remain required.

## Context

OpenLink is the first consumer of Hydite Auth, Workspace and public capability
SDKs. Its application workspace/project IDs and ZOKERBASE identities are not
automatically Hydite runtime project IDs or OAuth subjects. Local must remain
independent. The existing encrypted Zorker session bridge is not a Hydite OAuth
credential and cannot be forwarded as one.

## Decision

Cloud project references are implemented with local RLS/admin roles, revision
guards and remote visibility rechecks using each caller's own SDK. They do not
change native execution, including SSH targets. See
[`platform-cloud-project-links.md`](../platform-cloud-project-links.md). Positive
live mapping and runtime cutover are not covered by the completed negative checks.

Consume an integrity-pinned packed SDK through the existing artifact pattern.
Do not import sibling repository source, merge service dependencies, or duplicate
OAuth code. `lib/platform-cloud-sdk.ts` composes public SDK subpaths only; it has
no Code Plan dependency. It rejects Local before constructing any session.

A request-scoped Cloud adapter receives the authenticated application user, a
persisted issuer/subject link and a user-bound token store. Identity is checked
through the trusted issuer's userinfo endpoint, never by unverified JWT decoding
or matching email. The BFF must authorize application project access through
ZOKERBASE RLS before supplying the explicit application-to-platform project binding.
Platform authorization independently checks the OAuth user against that project.

Next implementation gates: durable encrypted Cloud connection storage, atomic
cross-process refresh coordination, explicit connect/disconnect and callback state,
RLS-protected project mapping, then BFF/Agent Host integration and actual UI flow.
The storage/coordination gate now has implementation and real cross-instance API
evidence; process-kill/recovery drills and the remaining consumer flows are not
covered by that evidence. Revocation acknowledgement requires a server-only
receipt, not merely the application user's JWT.
Do not expose this adapter through an unauthenticated route or accept its binding
as a trusted browser request body. Never cache its token store globally or share
one user's credential with another project member.

## Alternatives considered

- Existing cross-app JWT forwarding: does not establish the new OAuth audience
  or subject binding and is not a replacement for the SDK.
- Replacing all ZOKERBASE identity/data with Hydite: violates Local/Cloud and data
  ownership invariants; no implicit identity merge or data migration is permitted.
- Direct Bifrost or sibling-source imports: vendor/private coupling and nonportable
  builds; rejected. The product uses Hydite public contracts.

## Lifecycle, security and recovery

Build/release provisions the reviewed archive before dependency installation.
Runtime never fetches SDK code. Missing artifact/configuration/identity or denied
cloud authority is an explicit error, never fake readiness or Local fallback.
Tokens remain in the owning encrypted server/OS store; the adapter supplies no
plaintext persistence fallback. Login/disconnect must invalidate the matching
connection, not Local identity or another user's session. Lease recovery uses
Workspace SDK capabilities and retains explicit application/project mappings.

## Migration and rollback

Existing Local, Zorker SSO and native Project VM flows are unchanged in this batch.
Cloud cutover stays gated until the storage, BFF, service and end-to-end checks
exist. Retain old package manifest/lockfile and artifact for rollback; do not
relabel an existing Local project as Cloud or move its files implicitly.

## Verification

Required: packed-artifact installation, trusted endpoint/subject and cross-user
binding tests, Local no-network test, Cloud OAuth callback/refresh/disconnect,
application RLS, runtime create/reconnect/revoke, failure and rollback checks.
Unit adapter tests are not first-party end-to-end acceptance. Quantitative SLOs
must follow the existing non-functional standard and measured production evidence.
