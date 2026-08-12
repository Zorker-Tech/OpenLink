# ADR-0012: Treat desktop sandbox-runtime as a single-session process resource

## Status

Accepted

## Context

The desktop transport uses `@anthropic-ai/sandbox-runtime` around a Node.js Pi
SDK worker. Its public `SandboxManager` is process-global: the network proxy,
credential sentinel registry, filesystem restrictions and (on Windows) ACL
session are shared by the host process. Calling `initialize()` for a second
chat and `reset()` when the first chat closes would otherwise cross provider
credentials or tear down the first chat's sandbox.

## Decision

- A desktop Agent Host process owns one active sandbox-runtime session.
- `DesktopSandboxRuntimeNodeBackend` holds a process lease across the whole
  worker lifetime, serializes provider setup, and rejects a second active
  session with retryable `SESSION_BUSY`.
- Cleanup resets the global manager before releasing the lease. A failed reset
  keeps the session entry retryable instead of pretending the runtime is gone.
- The desktop host profile rejects `OPENLINK_AGENT_MAX_SESSIONS` values above
  one. Desktop shells that need multiple concurrent chats start one supervisor
  process per chat; web OpenSandbox and remote Project VM transports retain
  independent per-session workloads in a single Agent Host.

## Consequences

- Provider API keys and proxy state cannot be swapped between desktop chats.
- Desktop concurrency is process-based rather than shared-manager based, which
  costs one lightweight Node supervisor per active desktop chat.
- The web and remote session capacity settings are unaffected because their
  OpenSandbox control planes support independent workloads.

## Failure handling

- A second desktop prompt receives `SESSION_BUSY` instead of waiting behind an
  unknown global proxy state.
- Provisioning failures perform a best-effort `reset()` and release the lease;
  normal cleanup keeps the lease held until reset succeeds so the reaper can
  retry safely.
