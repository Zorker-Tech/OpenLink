# ADR-0014: ZOKERBASE Knowledge Backend

## Status

Accepted

## Context

OpenLink needs a shared knowledge base for personal and organization
workspaces. PostgreSQL/ZOKERBASE is already the source of truth for identity,
ownership, permissions, documents, chunks, and job state, while vector
similarity search requires a vector runtime. Project VMs must not receive database or
vector-database credentials, and local mode must remain independent from the
cloud data domain.

Zero Standalone and Distributed have different operational topologies. A
Standalone instance cannot be upgraded in place to a Distributed cluster, so a
mode change needs a second cluster and an explicit data migration/cutover.

## Decision

Use an OpenLink-owned Knowledge Service as the sole access boundary:

```text
browser / Next BFF / Project VM
              │ internal bearer token
              ▼
       Knowledge Service
          │           │
          ▼           ▼
      ZOKERBASE     Zero
  metadata/RLS    vector projection
```

- ZOKERBASE stores knowledge backend configuration, workspace-scoped
  collections, document source text, chunks, jobs, and deployment state.
- Zero stores only vector rows and non-sensitive tenant/document identifiers.
- Every Zero search includes server-generated workspace and collection
  filters; caller-provided vector expressions are never passed through.
- Local mode starts a product-owned Zero Standalone stack under
  `.openlink-runtime/knowledge/zero` and never pulls upstream images during
  ordinary startup.
- Distributed mode is a queued SSH/Kubernetes workflow. It deploys a new
  cluster, creates the target schema, rebuilds or migrates vectors, validates
  counts/schema/sample queries, switches the Knowledge Service endpoint, and
  retains the old backend for rollback.
- SSH private keys are encrypted with the existing OpenLink provider-secret
  AES-GCM boundary and are not put in job payloads or returned to clients.

## Consequences

### Positive

- One authorization and tenant-isolation boundary serves browser and VM calls.
- Local identity and knowledge data remain fully independent from cloud mode.
- Standalone is simple for default installations while Distributed remains a
  supported scale-out path.
- PostgreSQL remains queryable and auditable even if Zero is temporarily
  unavailable.

### Negative

- The Knowledge Service is an additional supervised runtime.
- Embedding providers and Zero require explicit local credentials/artifacts.
- Distributed migration temporarily consumes two vector backends.

## Alternatives Considered

### Project VM-local Zero

Rejected: duplicates data and lifecycle per project and makes shared workspace
permissions difficult to enforce.

### Direct browser/VM access to Zero

Rejected: exposes vector credentials and makes tenant filters dependent on
untrusted clients.

### Embedded vector runtime in Node

Rejected for the shared multi-project service. It is useful for small Python
single-process scenarios but does not provide the complete Standalone feature
set required here.

## Protocol

Zero exposes the OpenLink Zero Vector Protocol through the internal Knowledge
Service boundary. The service translates that protocol to the vendored engine's
REST implementation; implementation details are never part of the OpenLink
runtime contract or client configuration.
