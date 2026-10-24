# ADR-0027: Separate the platform control plane from the tenant application database and govern desktop resources dynamically

## Status

Accepted

Refines the data-ownership decision in
[ADR-0020](./ADR-0020-zokerbase-platform-console.md) and the resource-governance
model in
[ADR-0022](./ADR-0022-production-deployment-profiles-and-resource-governance.md).
It does not change their administrative surface boundaries.

## Context

ADR-0020 established ZOKERBASE Platform Console as the single logical platform
control plane and made ZOKERBASE the authoritative store for product identity,
tenancy, authorization, desired platform state, operation history and audit.
ADR-0022 separated deployment profiles, Project runtime backends, tenant
entitlements and platform capacity, and made tenant entitlement application
domain data while reserving global capacity for platform operators.

The implementation has since diverged from one part of that model. Today:

- Supabase/ZOKERBASE is the tenant application database. The `openlink` schema
  owns profiles, organizations, workspaces, projects, chat sessions, tenant
  provider settings, knowledge and application data.
- The tenant Next.js Web/BFF is the only tenant-facing access surface.
- Supabase Studio is a database engineering and break-glass diagnostic surface.
- There is no platform administrator role, no Platform Control API, no
  Deployment Controller, no platform resource/operation/audit schema and no
  Platform Console UI.
- `OPENLINK_AGENT_MAX_SESSIONS` is a host-wide session cap, not a tenant or
  platform capacity model.
- The desktop is either a GNOME/Xvfb userspace in the session workload
  (`ubuntu-container`) or a nested QEMU/KVM Ubuntu guest (`ubuntu-iso`). Desktop
  vCPU and memory are currently hardcoded defaults in
  `services/agent-worker/desktop/run-ubuntu-vm.sh`; the Agent Host does not
  inject per-session values. OpenSandbox resource limits and QEMU `-smp`/`-m`
  are creation-time settings and cannot be changed on a running session.
- Desktop prewarm, QMP `stop` idle sleep and QMP `cont` wake are implemented,
  but their caps and timings are process-wide environment settings rather than
  policy resolved from tenant entitlement and platform capacity.

Two problems follow.

First, platform state and tenant application state have different lifecycles,
blast radii and authorization models. Node inventory, cluster credentials,
deployment topology, releases, operations and platform audit do not belong in
the database that serves tenant chat, RLS policies and Supabase Studio. Mixing
them would make tenant-facing RLS the only barrier around operator data, couple
tenant application migrations to infrastructure schema, and make the platform
control plane depend on the availability and release cadence of the tenant
application database.

Second, a full Ubuntu desktop guest is expensive relative to the session
container. A nested guest reserves several GB of the Project VM and a fixed
vCPU count. Running one per session at a fixed size makes resource usage scale
with the number of open chats, independent of what those chats actually need.
The product needs a policy that grants each desktop a size derived from the
project's desired shape, the tenant's remaining entitlement and the platform's
remaining capacity, keeps the desktop dormant when it is not in use, and never
lets a tenant exceed a global ceiling.

## Decision

### Two data planes, two stores

OpenLink will maintain two explicitly separated data planes.

| Plane | Store | Owns | Must not own |
| --- | --- | --- | --- |
| Tenant application plane | Supabase/ZOKERBASE, `openlink` schema and Auth | Users, organizations, workspaces, projects, chat sessions and events, tenant provider settings, knowledge, tenant entitlements/allocations/reservations, Project runtime desired state, application audit | Node or cluster inventory, platform administrators, global capacity, releases, deployments, operations, platform audit, infrastructure credentials |
| Platform control plane | Independent `openlink_platform` database with a dedicated role | Platform administrators and roles, node/cluster inventory, deployment targets, releases, deployments, service/database/traffic topology, operations, observed platform state, secret references, global capacity and desktop policy, platform audit | Tenant user/organization/project/chat data, tenant entitlement editing, tenant application workflows |

The two planes must not share a schema, a database role, a migration stream or
a transaction. The platform store may contain opaque tenant, project and
session identifiers for scheduling and incident response, but it must not
contain tenant profile data, chat content or other tenant application payloads.
There must be no cross-database joins.

When the platform control plane needs tenant aggregates (for example active
Project counts or reserved desktop capacity), it reads them through a narrow
internal application API or a deliberately published read-only projection. It
does not query the tenant `openlink` tables directly, and the tenant application
does not query `openlink_platform`.

For single-node deployments, the platform database may run on the same
PostgreSQL instance as Supabase as a separate database and role. That is a
deployment convenience, not a data-model exception: it still has separate
credentials, backups, migrations and restore procedures. Multi-node
deployments use a dedicated, highly available control-plane database.

### Independent Platform Console process and surface

The Platform Console is a separate product surface, not a page in the tenant
application.

- The Console UI and the Platform Control API run as independent processes. The
  API binds to loopback or a private network and is the only writer for
  `openlink_platform`. The UI talks to the API and never receives database,
  cluster, SSH or load-balancer credentials.
- The Console is served on its own origin, for example `console.<domain>`, with
  its own session and its own release cadence. It is not mounted at `/admin` in
  the tenant Next.js application.
- The tenant Web/BFF remains the only tenant-facing access surface. It does not
  proxy platform operations, does not share cookies with the Console and is not
  a fallback for operator actions.
- Supabase Studio remains a database engineering and break-glass diagnostic
  surface. It is not mounted at `/admin`, does not become the Platform Console
  and does not own platform policy or deployment state.
- The Console creates durable operations and the Deployment Controller executes
  them; the browser never supplies arbitrary shell commands, manifests or
  infrastructure endpoints.

### Platform identity and authorization

Platform identity is separate from tenant identity.

- Platform administrators authenticate against the platform control plane, not
  by reusing `openlink.organization_members`, tenant JWTs or tenant roles.
- Production deployments should use the deployment's OIDC/identity provider.
  A single-node self-hosted deployment may use a locally bootstrapped platform
  administrator with an Argon2id password hash and TOTP. Bootstrap credentials
  are generated by the operator CLI, stored only in the platform store, and
  never seeded from a tenant account.
- Platform roles are stored in `openlink_platform` (for example
  `platform_admin`, `platform_operator`, `platform_auditor`). Tenant roles never
  imply platform authority.
- MFA is required for platform administrators. Destructive or cross-tenant
  operations require explicit reauthorization and produce an immutable audit
  event. Platform sessions are short-lived and separate from tenant sessions.

### Dynamic desktop resource governance

Desktop sizing becomes a policy decision instead of a fixed script default.
The policy has four inputs, each with a distinct owner.

| Input | Owner | Examples |
| --- | --- | --- |
| Global ceiling and safety reserve | Platform control plane | `desktop_max_vcpus`, `desktop_max_memory_mb`, `max_concurrent_desktops`, `desktop_prewarm_cap`, `desktop_idle_ttl_seconds`, `platform_safety_reserve`, `policy_revision` |
| Tenant ceiling | Tenant application plane (OpenLink Settings), bounded by the global ceiling | Per-user or per-organization desktop vCPU/memory cap, concurrent desktop cap, prewarm preference, idle TTL |
| Project desired shape | Tenant application plane, `project_runtimes.desired_*` | Desired vCPU, memory and disk for the Project; the desktop inherits or narrows this shape |
| Observed usage | Agent Host and Project runtime | Granted vCPU/memory, desktop state, actual CPU/memory use, `over_limit` flag |

Admission uses a reservation, not a stored count:

```text
requested = project desired desktop shape or the profile default
ceiling   = min(global max, tenant max, project desired, platform remaining)
granted   = clamp(requested, safety_floor, ceiling)
```

- `safety_floor` is the minimum vCPU/memory at which the guest can boot. It is a
  boot guard, not a reservation. There is no permanently reserved minimum per
  session.
- If `ceiling < safety_floor`, or the platform cannot reserve the requested
  amount, the desktop is not started or prewarmed. It remains dormant and the
  caller receives an ADR-0022 reason code such as
  `PLATFORM_CAPACITY_EXHAUSTED` or `TENANT_CONCURRENCY_EXHAUSTED`.
- Reservations use an idempotency key and are released when provisioning fails
  or the session/desktop is removed. Concurrent admissions must not exceed the
  ceiling through a race.

Application rules:

- The chosen values are applied when the session sandbox is created and when
  the desktop QEMU process starts. The sandbox memory limit must include the
  guest memory plus QEMU, VNC, websockify and worker overhead.
- OpenSandbox resource limits and QEMU `-smp`/`-m` are create-time settings.
  There is no live resize. A policy change applies to new sessions and to
  desktops that are fully restarted; a QMP `stop`/`cont` cycle does not change
  the allocation.
- When a ceiling is reduced below a live allocation, the allocation is marked
  `over_limit` and is not terminated by default. New sessions use the new
  ceiling; existing sessions keep their allocation until their next restart.
  Forced enforcement is a separately authorized and audited operation.
- Disk is allocated when the per-session qcow2 is created. The policy may choose
  the size within the Project disk budget, but online grow/shrink is not
  assumed.

Dormancy rules:

- Idle desktops are paused with QMP `stop` after the effective idle TTL. QMP
  `cont` resumes them when a desktop client connects. QMP stop releases vCPU
  execution but retains guest RAM; it does not free memory.
- The prewarm cap is a capacity-aware policy value, not a fixed global default.
  Prewarming is skipped when the platform or tenant reservation would fail.
- Under sustained memory pressure, a longer idle policy may shut the guest down
  or persist and release its state. That makes wake slower and is therefore a
  separate policy decision, not the default.
- The `ubuntu-container` desktop has no guest QMP socket. It remains running
  under the current contract and is not suspended by the QMP policy.

### Monitoring and observability

- The Agent Host exposes a read-only per-project/per-session resource view:
  desktop state, granted vCPU/memory, policy revision, `over_limit` state and,
  where available, observed CPU/memory usage.
- The Platform Console aggregates node, Project VM and session capacity and
  presents allocated, reserved and used values with an observation timestamp.
  A stale observation is labeled stale and is not reported as ready.
- Admission outcomes use the ADR-0022 low-cardinality reason codes. Public
  metrics must not contain tenant identities or chat content.
- Audit events are written in the same transaction as the policy or operation
  that they describe. A failed audit write fails the privileged mutation
  closed, except for a documented offline recovery procedure.

### Deployment and cluster scope

This ADR does not implement a Deployment Controller, Kubernetes/k3s drivers or
multi-cluster placement. Those remain ADR-0020 Phase 3 and Phase 4 work.

The platform schema reserves the entities needed by those phases: deployment
targets, clusters, nodes, releases, deployments, service/database/traffic
topology, operations, observed status, secret references and audit events.
Node and topology data live only in the platform store. They never enter the
tenant application database.

Until a Deployment Controller exists, the single-node operator lifecycle
remains the authoritative executor, and the Platform Console may expose only
read-only inventory and policy views. The Console must not pretend that a
desired-state record has been reconciled when no controller has observed it.

### Relationship to existing decisions

- ADR-0020's administrative boundaries remain binding: OpenLink Settings is
  tenant-facing, ZOKERBASE Studio is diagnostic, and the Platform Console is
  operator-facing. This ADR refines only the statement that ZOKERBASE is the
  authoritative store for platform desired state and audit. Tenant identity,
  tenancy and application data remain in ZOKERBASE/Supabase; platform desired
  state, operations and audit move to `openlink_platform`.
- ADR-0022's tenant entitlement model remains in the tenant application plane.
  Global capacity and global desktop policy live in the platform plane. The
  admission decision reads both and must not substitute one for the other.
- ADR-0026's desktop lifecycle (prewarm, QMP stop/cont, installer protection)
  remains. This ADR adds dynamic sizing and capacity-aware prewarm/idle policy.

## Consequences

### Positive

- Tenant application data and platform infrastructure data have explicit,
  independently securable owners.
- Tenant RLS policies cannot accidentally expose node, cluster or deployment
  data, and platform operations cannot accidentally mutate tenant application
  data.
- The Platform Console can evolve and be released independently from the
  tenant Web/BFF.
- Desktop resource usage follows actual project and tenant demand instead of a
  fixed per-session reservation.
- Global ceilings, tenant limits and project desired shapes are auditable and
  attributable to a policy revision.
- The model leaves a clean path to multi-node and multi-cluster drivers.

### Negative

- Two stores mean two backup, restore, migration and disaster-recovery paths.
- Two identity systems mean separate bootstrap, MFA, session and audit flows.
- Cross-plane admission is eventually consistent; reservations, idempotency and
  compensation are required to avoid over-admission.
- The platform control plane is substantial new software and operational
  surface.
- Desktop resource changes require a restart or session recreation because
  OpenSandbox and QEMU do not support live resize.
- QMP stop does not free guest memory, so memory pressure may still require
  shutdown or a stricter prewarm policy.

### Operational

- Backups must cover both stores and document restore order. Restoring the
  tenant database without the platform store, or the reverse, must not produce a
  state that reports resources as ready when they are not.
- Platform administrators need a documented bootstrap, break-glass and key
  rotation procedure.
- The single-node deployment gains additional processes, ports, systemd units
  and release payload entries.
- Monitoring must distinguish tenant entitlement denial, platform capacity
  exhaustion, runtime capability failure and workload failure.

## Alternatives Considered

### Put platform data in the Supabase `openlink` schema

Rejected. It would couple platform migrations to tenant application migrations,
make tenant RLS the only barrier around infrastructure data, and put node,
cluster and deployment records in the database that tenant users and Studio can
reach. It would also make the platform control plane unavailable whenever the
tenant application database is unavailable.

### Mount Supabase Studio at `/admin`

Rejected. Studio is an upstream database engineering and break-glass surface. It
does not own product policy, tenant entitlements, operations, audit or
deployment state, and a deep fork would couple the product to upstream UI
changes. It remains a separate diagnostic surface.

### Put the Platform Console under the tenant application's `/admin`

Rejected. It would bind the operator surface to the tenant access surface,
share cookies and release cadence, and make the tenant BFF a platform control
path. The operator surface must be independently authenticated and deployed.

### Keep ZOKERBASE as the authoritative platform store

Rejected for platform state, refined for tenant state. ADR-0020's intent is
preserved, but the store boundary is corrected: ZOKERBASE remains authoritative
for tenant identity, tenancy and application data; platform desired state,
operations and audit belong in a separate control-plane store.

### Resize desktop guests live

Rejected. OpenSandbox resource limits and QEMU `-smp`/`-m` are creation-time
settings. Implementing live resize would require memory/CPU hotplug and a
sandbox resize API that do not exist, and would make capacity accounting much
harder. Policy changes apply at the next create or restart.

### Use SQLite for the platform store

Rejected for production. It cannot provide the concurrency, lease/fencing,
backup and high-availability behavior the control plane needs. It may be used
for a local development profile only.

### Give every session a fixed desktop size

Rejected. It is the current behavior and the reason resource usage scales with
open chats. Sizing must follow project demand, tenant entitlement and platform
capacity.

## Implementation Phases

1. **Phase 0 — this ADR and contracts.** Define the data ownership boundary,
   platform schema, API contracts, desktop policy fields, admission formula and
   reason codes. No runtime code.
2. **Phase 1 — dynamic desktop policy.** Add the platform policy store, tenant
   desktop limits, the Agent Host resource resolver, sandbox/QEMU resource
   injection, `over_limit` reporting and a read-only resource view.
3. **Phase 2 — Platform Console MVP.** Add platform administrator bootstrap,
   the Platform Control API, node/capacity inventory, policy management,
   operation/audit views and the independent Console UI.
4. **Phase 3 — single-node Deployment Controller.** Add durable operations,
   leases/fencing, a bounded single-node driver and observed-generation
   reconciliation.
5. **Phase 4 — cluster drivers.** Add Kubernetes/k3s inventory and deployment
   adapters, placement and multi-cluster policy only after the single-node
   contracts are proven.

## Open Decisions

- Whether the single-node platform database is a separate database on the
  existing PostgreSQL instance or a dedicated instance; and the HA topology for
  multi-node.
- Whether platform administrators use OIDC only or a local bootstrap fallback,
  and how MFA is enforced for break-glass accounts.
- Whether tenant aggregates are read through an internal application API or a
  read-only projection, and how freshness is surfaced.
- The exact safety floor and QEMU/worker overhead constants used to translate a
  guest allocation into a sandbox memory limit.
- Whether the Console UI is a separate frontend application or a
  server-rendered service; both must remain a separate origin from the tenant
  application.
- Whether desktop limits are configured per user, per organization or both,
  and how an organization delegates its ceiling to members.

## References

- [`ADR-0020`](./ADR-0020-zokerbase-platform-console.md)
- [`ADR-0022`](./ADR-0022-production-deployment-profiles-and-resource-governance.md)
- [`ADR-0026`](./ADR-0026-opensandbox-desktop-session-surface.md)
- [`ADR-0007`](./ADR-0007-project-vm-runtime-boundaries.md)
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md)
- [`standards/02-system-context.md`](./standards/02-system-context.md)
- [`standards/05-data-and-security.md`](./standards/05-data-and-security.md)
- [`standards/07-non-functional-requirements.md`](./standards/07-non-functional-requirements.md)
