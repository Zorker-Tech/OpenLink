# ADR-0014: Eager Project Runtime Provisioning

## Status

Accepted — 2026-08-10

## Context

Project runtimes are currently materialized only when the first chat prompt or
code-server request reaches Agent Host. A new Project therefore appears usable
before its VM exists, while the first conversation remains on a misleading
`Thinking…` state for the entire VM provisioning interval. The database already
creates one `project_runtimes` desired-state row for every Project, but no
background service consumes that row.

Personal, organization, and default Draft Projects must use one lifecycle. A
conversation must never be created against a Project whose execution boundary
is not ready.

## Decision

Use the database as a durable desired-state queue and Agent Host as its
reconciler.

- `creating` is a client-side state while the create command is in flight.
- A committed Project starts as `waiting` and already has its
  `project_runtimes` row.
- Agent Host continuously claims eligible runtime rows with a renewable lease
  and calls the existing idempotent `ProjectRuntimeManager.ensure(projectId)`.
- A database trigger maps runtime `ready` to Project `active`; every other
  non-deletion runtime state keeps the Project `waiting`.
- The server-side chat creation path requires both Project `active` and runtime
  `ready`. UI disabling is supplementary and is never the authorization gate.
- Workspace creation continues to create its default Draft Project in the same
  transaction. Consequently personal Draft provisioning starts as soon as the
  personal workspace is committed, and organization Draft provisioning starts
  as soon as the organization workspace is committed.
- Project creation persists an immutable disk allocation mode. `thin` is the
  default and creates a copy-on-write/sparse disk whose host allocation grows
  with actual writes. `thick` creates an independent, fully allocated disk
  after a host-capacity preflight. The system Draft Project is always `thin`,
  enforced by a database constraint; only manual Project creation exposes the
  choice. Both modes boot the same complete VM image and run the same services.

The same reconciler runs against the configured self-hosted backend and Local
ZOKERBASE. Their data domains remain isolated; each process only sees the
backend endpoint configured for that runtime. This decision does not depend on
Supabase's hosted Cloud product and leaves a future hosted-storage redesign
open.

## Alternatives

1. Provision synchronously inside project creation. Rejected because VM startup
   would block the form and could outlive an HTTP request.
2. Send a fire-and-forget request from the web server. Rejected because process
   restarts lose the request and leave Projects permanently waiting.
3. Start only on the first conversation. Rejected because this is the current
   failure mode and makes a non-ready Project look active.

## Consequences

Provisioning survives page closure and service restart, runtime creation is
deduplicated by a lease plus the manager's per-project lock, and Project cards
can display truthful state. The reconciler adds a small polling load and must
renew its claim during long VM creation. Failures stay non-active and are
retried with bounded backoff; they never permit chat creation.
