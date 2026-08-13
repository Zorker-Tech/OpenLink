# ADR-0013: Use One ZOKERBASE Runtime Topology for Local and Cloud

## Status

Accepted

## Context

OpenLink stores application state through the self-hosted ZOKERBASE
Supabase-compatible
HTTP APIs. This makes a locally-run application depend on PostgREST/Auth
availability for every business read and makes transient gateway timeouts look
like application failures. The product needs two explicit runtime choices:
Cloud keeps the deployed self-hosted Supabase control plane, while Local must
provide the same Auth, RLS, REST, Realtime and Storage behavior on the user's
machine.

Pi session history is an ordered, append-only log. Losing its ordering,
crossing the Cloud/Local boundary inside one session, or persisting each turn
to a different database would fork the native Pi session.

## Decision

Vendor a pinned sparse source snapshot at `backend/`. Keep the upstream
self-hosted `backend/docker` topology and Studio source plus only Studio's
internal workspace dependencies. Do not vendor www, docs or other marketing
applications. Layer the ZOKERBASE Compose overlay on the topology and produce
our own versioned `zokerbase/*` image artifact; service startup must never
reference or pull upstream image names.

Introduce a server-only `OPENLINK_RUNTIME_MODE=local|cloud` switch. Cloud uses
the configured deployment. Local defaults to a self-contained ZOKERBASE stack,
generates all secrets and API keys once with the upstream-supported generators,
and applies the exact same `zorkerbase/migrations` files before Next.js and Agent
Host start. Both modes use Supabase-compatible clients, PostgREST RPCs and RLS.

Local ZOKERBASE Auth is the local identity issuer. Local and Cloud are
independent identity and data domains: Local never reads Cloud URLs, API keys,
JWT signing secrets, user rows, or application records. Password hashes,
refresh tokens, and sessions are not copied between modes.

## Consequences

### Positive

- Local and Cloud preserve identical API, RLS and migration behavior while
  remaining separate identity and data domains.
- A session has one authoritative persistence store for its whole lifetime.
- Cloud retains Supabase RLS and multi-user behavior without weakening it for
  Local development.

### Negative

- Local mode runs the full self-hosted service set and therefore consumes more
  disk and memory than a standalone PostgreSQL process.
- Cross-mode migration is an explicit operation; the stores are intentionally
  not replicated continuously.

## Alternatives Considered

- **Direct Local PostgreSQL adapter:** rejected because it would duplicate
  PostgREST semantics and bypass RLS, Realtime and Storage.
- **Store Local state in JSONL only:** rejected because projects, provider
  settings, leases and ordered event queries require transactional relational
  storage.
- **Use Cloud PostgreSQL directly in Local mode:** rejected because it does
  not provide offline/local isolation and is functionally still Cloud mode.

## References

- [Supabase self-hosting with Docker](https://supabase.com/docs/guides/self-hosting/docker)
- Vendored upstream metadata: `backend/UPSTREAM.md`
- Shared application schema: `zorkerbase/migrations/`
