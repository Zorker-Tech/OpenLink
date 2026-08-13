# Knowledge backend implementation plan

## Scope

This phase implements the backend only. Frontend pages remain unchanged.

## Delivered boundaries

1. `openlink.knowledge_*` tables in ZOKERBASE with workspace RLS and
   service-role-only writes.
2. `services/knowledge-service` with internal bearer authentication,
   collection/document/job APIs, deterministic chunking, embedding provider,
   Zero vector protocol integration, tenant filters, and queued Distributed deploy
   requests.
3. `scripts/zero.mjs` supervising the local Zero Standalone dependency.
4. `scripts/dev-browser.mjs` starting and stopping Zero and Knowledge
   Service as part of local OpenLink lifecycle.

## Data flow

```text
document text
  → ZOKERBASE queued document/job
  → deterministic chunks
  → embedding provider
  → Zero upsert
  → ZOKERBASE chunk metadata
  → ready document/job
```

Search embeds the query, applies server-generated workspace/collection filters
in Zero, then hydrates citation content from ZOKERBASE.

## Follow-up work

- Add Next.js BFF routes after the data contract is smoke-tested.
- Implement the queued SSH/Kubernetes deployment worker using strict
  `known_hosts` and the existing `SshTransport`.
- Add full migration/export validation for Standalone → Distributed.
- Build and package the product-owned Zero images in release artifacts.
