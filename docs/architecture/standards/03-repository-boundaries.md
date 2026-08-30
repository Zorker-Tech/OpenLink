# Repository and dependency boundaries

## Directory ownership

| Path | Classification | Rules |
| --- | --- | --- |
| `app/`, `components/`, `lib/`, `utils/` | OpenLink Web/BFF | Root pnpm/Next.js conventions; no privileged runtime imports |
| `packages/` | OpenLink shared packages/artifacts | Must have an explicit consumer and stable contract |
| `services/agent-host`, `agent-worker`, `agent-rpc-worker`, `browser-host`, `knowledge-service` | OpenLink-owned services | Independent package/build boundary; communicate through contracts |
| `services/pi`, `opensandbox`, `sandbox-runtime`, `code-server`, `linux`, `zero` | Vendored runtime source | No nested `.git`; no casual refactor; update from pinned upstream with review |
| `backend/` | Sparse ZOKERBASE upstream-compatible source snapshot | Keep self-host runtime, Studio, and required workspace packages; product changes belong in overlays/patches where possible |
| `zorkerbase/migrations/` | Authoritative application schema history | Append-only migrations; Local and Cloud-compatible schema contract |
| `scripts/` | Root lifecycle and artifact production | Idempotent, non-interactive, explicit build/start distinction |
| `docs/architecture/` | Architecture decisions and standards | Update with architectural changes |
| GitLab Container/Generic Package Registry | Portable Docker/OCI release images | Publish immutable image tags/digests outside Git; keep source/build metadata in Git; never include mutable runtime state |
| `.openlink-runtime/`, `.openlink-releases/`, `.agent-data/`, `.next/` | Generated/runtime state | Never source-controlled; never treated as source of release code |

## Dependency rules

1. The Next.js graph must not import source from privileged or vendored
   `services/` trees.
2. A service may use its own package manager and lockfile. Do not merge a
   service's dependencies into the root merely to make an import convenient.
3. Cross-service communication uses versioned HTTP, WebSocket, JSONL/RPC, or
   packaged-artifact contracts. It does not use source-level imports across
   trust boundaries.
4. Browser-safe modules must never import `server-only` modules or secrets.
5. Root path aliases (`@/*`) belong to the Web/BFF application and are not a
   service integration mechanism.
6. The root TypeScript/build configuration must exclude vendored applications
   and service source. A broad `**/*.ts` include without matching exclusions is
   not an acceptable long-term boundary.

## Vendored source policy

Vendored source is part of the root repository for reproducible releases, but
remains independently buildable. It must not retain nested Git metadata or be
represented as a Git submodule.

For an upstream update:

1. Record the current and target revisions.
2. Import only the intended upstream tree/sparse paths.
3. Review licenses, release notes, schema/image changes, and security impact.
4. Reapply product overlays and patches explicitly.
5. Update `services/source-revisions.json` or `backend/UPSTREAM.md`.
6. Build the affected artifact and run its contract/integration tests.

Product behavior must be implemented in OpenLink-owned adapters, Compose
overlays, patches, and build scripts whenever possible. Editing upstream source
directly is allowed only when an overlay cannot express the change; document
such changes so the next upstream import does not erase them.

## Generated artifacts

The following categories are generated and must not be hand-edited as product
source:

- `.openlink-runtime/**` local state and secrets;
- `.openlink-releases/**` packaged releases;
- mutable container storage, database volumes, Podman machine state, VM raw
  disks, and image tar archives;
- `.next/**`, service `dist/**`, and dependency directories;
- Project VM disks and OCI archives;
- generated Pi tarballs and manifests, except their checked-in source metadata
  where the release process explicitly requires it.

Artifact production may acquire pinned upstream inputs only in an explicit
build mode. Ordinary startup must use local, product-owned artifacts and fail
with an actionable error when they are absent.

## Naming rules

- Product-facing database/runtime naming: `ZOKERBASE` / `zokerbase`.
- Product-facing vector naming: `Zero` and management surface `ZeroLink`.
- Internal application namespace may remain `OpenLink` while the user-facing
  application brand evolves.
- Upstream names remain in attribution, compatibility comments, and original
  vendored code only.
- New filenames, environment variables, container names, and runtime paths use
  product names rather than introducing new legacy `supabase` or `milvus`
  aliases. Existing compatibility aliases require an explicit removal plan.
