# OpenLink architecture rules

Read this file before changing system boundaries. The complete normative
specification is in [`docs/architecture/standards/`](./docs/architecture/standards/README.md),
and accepted decisions are indexed by [`docs/architecture/README.md`](./docs/architecture/README.md).
The baseline for reliability, performance, security, and operability is
[`07-non-functional-requirements.md`](./docs/architecture/standards/07-non-functional-requirements.md).

## System shape

OpenLink is one supervised product composed of separate trust/process
boundaries:

```text
Browser
  → Next.js Web/BFF
      → ZOKERBASE (identity + authoritative application data)
      → Agent Host → Project VM → OpenSandbox → Agent Worker/Pi
      → Browser Host → native preview / isolated Chromium
      → Knowledge Service → ZOKERBASE + embedding provider + Zero
```

## Binding invariants

1. **Local and Cloud have equal contracts but isolated identity and data.**
   Local never depends on or synchronizes with Cloud during normal operation.
2. **Next.js is not a privileged runtime.** Shell, VM, SSH, browser-profile,
   service-role, and vector authority stays in owned services.
3. **ZOKERBASE is the application source of truth.** Zero is a rebuildable
   vector projection; Project VM `/workspace` is the project-file/Git source.
4. **Project VM and Agent Worker lifecycles are independent.** Workers may
   pause while the durable Project VM and project services remain resident.
5. **No client connects directly to privileged services.** Use BFF routes,
   internal bearer authentication, and short-lived scoped capabilities.
6. **Network and credentials are default-deny capabilities.** Agent requests
   do not bypass user/policy decisions.
7. **Ordinary startup runs prebuilt local artifacts.** It does not pull a
   machine OS or rebuild product images as part of serving requests.
8. **Vendored runtimes are source inputs, not nested repositories or root
   packages.** Integrate them through OpenLink-owned adapters and overlays.
9. **Model/runtime state must be real.** Missing models, failed VMs, and
   unhealthy services are never represented as ready or replaced by fake data.
10. **Architectural changes require an ADR.** Update the standards and include
    migration, rollback, failure, security, and lifecycle analysis.
11. **Local host support is native and contract-equal.** macOS uses AppleHV
    with sparse raw/APFS clones; Windows uses Hyper-V with dynamic/differencing
    VHDX. WSL and Docker containers are not implicit Project VM fallbacks.

## Repository boundaries

- Product Web/BFF: `app/`, `components/`, `lib/`, `utils/`.
- Owned privileged services: `services/agent-*`, `services/browser-host`,
  `services/knowledge-service`.
- Vendored runtime source: `services/pi`, `opensandbox`, `sandbox-runtime`,
  `code-server`, `linux`, `zero`, plus the sparse `backend/` snapshot.
- Authoritative schema: `zorkerbase/migrations/`.
- Lifecycle and artifact production: `scripts/`.
- Portable release images: GitLab Container Registry (or Generic Package
  Registry); manifests and publication metadata remain in Git.
- Generated state: `.openlink-runtime/`, `.openlink-releases/`, `.agent-data/`,
  `.next/`; never edit or commit it as product source.

Do not solve a dependency problem by importing a privileged/vendored service
into Next.js or by merging its dependency graph into the root workspace.

## Product vocabulary

- Application/internal namespace: OpenLink; current user-facing product brand
  may use Zorker.
- Data platform: ZOKERBASE.
- Vector runtime: Zero.
- Vector management surface: ZeroLink.

Upstream names belong only in attribution, compatibility documentation, and
unaltered vendored source. New product-facing files, images, environment
variables, runtime paths, and UI must use product names.

## Architecture change checklist

- Identify the authoritative owner of every new state.
- Identify every trust boundary, token, secret, URL, and port.
- Describe Local and Cloud behavior independently.
- Describe start, health, failure, retry, restart, and shutdown.
- Define migration and rollback for existing users.
- Add/update an ADR for a boundary or contract change.
- Verify the affected service contract and an end-to-end path.
