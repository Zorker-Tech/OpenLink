# ADR-0003: Separate Local and Remote Agent Execution Backends

## Status

Accepted

## Context

OpenLink has web and desktop clients. Web users may select a remote SSH target,
while desktop users execute on the local machine. Both modes need the same Pi
agent behavior, session lifecycle, streaming events, workspace semantics, and
audit model, but their isolation mechanisms are materially different:

- OpenSandbox is a remote sandbox control plane built around Docker or
  Kubernetes and exposes lifecycle, command, filesystem, network, volume, and
  credential-vault APIs.
- Anthropic sandbox-runtime wraps local processes with OS-level filesystem and
  network restrictions without requiring a local container control plane.
- Pi supports a strict JSONL RPC process mode and an in-process Node SDK.

Running any of these directly inside the Next.js server would give request
handlers excessive filesystem, process, SSH, Docker, and credential authority.

## Decision

Create `services/agent-host` as an independent Node service with one
backend-neutral contract and two adapters:

1. `LocalSandboxRuntimeBackend` compiles an OpenLink policy, initializes
   sandbox-runtime, wraps a Pi RPC command, and spawns it through an injected
   process factory.
2. `RemoteOpenSandboxBackend` produces a reviewed SSH bootstrap plan and uses an
   injected OpenSandbox adapter after target approval. OpenSandbox binds to the
   remote loopback interface and is reached through an authenticated tunnel.

The service owns policy compilation, path containment, credential redaction,
Pi JSONL limits, lifecycle state, and cleanup. Upstream repositories remain
pinned Git submodules and are never imported by the browser bundle.

Session metadata is centralized in OpenLink/Supabase. Workspace files, Pi
session JSONL, logs, and artifacts remain on the execution node by default.

## Consequences

### Positive

- Web and desktop clients share one session/execution contract.
- Sandbox implementations and Node runtimes can change independently.
- Remote Docker authority and local OS sandbox authority stay out of Next.js.
- Policies can be tested without connecting to SSH or starting a sandbox.

### Negative

- Deployment requires an additional agent-host process.
- Remote targets require preregistration, prerequisite checks, bundle signing,
  and an explicit privilege/approval flow.
- A production OpenSandbox SDK adapter, SSH transport, desktop process factory,
  and credential broker are still needed.

### Neutral

- The initial remote implementation emits an auditable bootstrap plan instead
  of silently modifying a target host.

## Alternatives Considered

### One common sandbox implementation

Rejected. OpenSandbox is appropriate for remote container lifecycle, while
sandbox-runtime is a lighter and more native desktop boundary.

### Direct Pi Node SDK inside Next.js

Rejected. It couples the web process to privileged agent tools and makes
resource cleanup and isolation depend on request lifetimes.

### Public OpenSandbox control-plane endpoint

Rejected. A server with access to the target Docker socket must not be exposed
without a dedicated private network, authentication, and authorization layer.

## References

- `services/pi`
- `services/opensandbox`
- `services/sandbox-runtime`
- `docs/plans/2026-08-05-agent-execution-boundaries-design.md`
