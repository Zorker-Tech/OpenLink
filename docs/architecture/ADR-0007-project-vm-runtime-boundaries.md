# ADR-0007: Project-owned VM and session-owned sandbox boundaries

## Status

Accepted

## Context

OpenLink currently creates browser sessions and Agent OpenSandbox workloads from
the shared local control plane. That makes the project workspace a volume path,
but does not give a project a long-lived execution boundary. The product model
requires a project to own its development environment while keeping every chat
session independently isolated inside that project environment. A session that
has no explicit project must still be deterministic and must not fall back to a
global host directory.

`services/linux` is the pinned Podman source tree. On macOS and Windows,
Podman's `machine` command provides a Linux VM; on Linux it can still be used
as an explicit VM lifecycle driver. OpenSandbox then manages session sandboxes
inside that VM. The VM must contain the toolchain image used by those sandboxes
(Git, Node/npm, pnpm, Python and common build tools).

## Decision

1. Every workspace receives a system project named `Draft`. It is marked with
   `projects.is_default = true` and has a unique partial index per workspace.
   Chat session creation resolves a missing `projectId` to this project before
   inserting the session row. Existing NULL project sessions are backfilled to
   Draft in the migration.
2. `openlink.project_runtimes` stores the durable VM identity and lifecycle
   state for each project. It is one-to-one with `projects`; it does not store
   session state or credentials.
3. Agent Host owns a `ProjectVmManager` and a `PodmanMachineDriver`. The driver
   executes `podman machine init/start/inspect/ssh/stop/rm` through argument
   arrays, never a shell command assembled from user input. Missing Podman or a
   failed bootstrap is a provisioning error, never a fake ready state.
4. The project VM is long-lived. Each Agent or Browser session is still
   created as a separate OpenSandbox workload using the project VM's runtime
   endpoint and project workspace. Session cleanup destroys only that session's
   sandbox, not the project VM.
5. Project and session identifiers are propagated through the BFF to Agent Host
   and Browser Host. This keeps the execution boundary explicit and allows the
   VM endpoint to be selected per project without trusting a client-supplied
   filesystem path.

## Consequences

### Positive

- Project files, browser profiles, Agent workers and OpenSandbox control plane
  can share a project-owned Linux environment without sharing session grants.
- New chats are never accidentally attached to a global workspace; Draft is a
  visible, queryable default project.
- VM lifecycle is durable and restartable while session sandboxes remain cheap
  and ephemeral.

### Negative

- A project consumes VM resources even when no session is active unless an
  idle-stop policy is configured.
- The repository's `services/linux` Podman source must be built for the host
  and target architecture before the VM can start; the user does not install
  a system Podman package manually.
- The VM image/toolchain must be versioned and rebuilt when development tools
  change.

### Neutral

- PostgreSQL stores project/runtime metadata and Cloud Pi sessions, while VM
  disks store working files and runtime logs.
- Browser Host remains protocol-compatible; only its project runtime endpoint
  selection changes.
- A runtime descriptor is health-checked before reuse. If its VM service
  endpoint disappeared outside Agent Host, the descriptor and host forwards are
  evicted and the project runtime is reconciled before the request continues.

## Alternatives considered

### One VM per user

Rejected. It allows unrelated projects to share filesystem and process
authority, which violates the requested project boundary.

### One OpenSandbox container per project

Rejected. A container is not a stable Linux VM boundary on macOS/Windows and
would make the VM/toolchain lifecycle depend on an individual session workload.

### Keep the current shared OpenSandbox host

Rejected. The shared host OpenSandbox control plane is not used by the Project
VM profile; provisioning fails if the Project VM and its in-VM control plane
are not ready.

## Failure handling

- VM creation or toolchain bootstrap failure marks `project_runtimes.status` as
  `error` and returns a retryable provisioning error.
- Session creation cannot proceed without a ready project runtime in VM mode.
- VM stop/restart does not delete the project workspace or Cloud Pi session
  records; a subsequent session rehydrates the VM endpoint.
