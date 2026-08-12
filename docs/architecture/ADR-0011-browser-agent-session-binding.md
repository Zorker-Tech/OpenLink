# ADR-0011: Bind Pi browser tools to the user-visible Browser Host session

- Status: Accepted
- Date: 2026-08-08

## Context

The Web UI creates a scoped Browser Host session for preview and realtime
interaction. Previously that session existed only in the browser UI: the Chat
API did not carry its id into Agent Host, and Pi workers therefore had no
browser capability even though the browser canvas was visible.

## Decision

The Browser Gateway retains the private Browser Host session and validates its
owner, workspace, and project before an Agent Host prompt can bind it. The Chat
API forwards the browser session id; Agent Host converts the private Browser
Host capability into an immutable worker binding. Local OpenSandbox Node SDK
workers and remote SSH/OpenSandbox RPC workers receive the same extension and
session-scoped control environment. The public gateway token and Browser Host
service token are never injected into Pi.

Project VM session containers address the project Browser Host through the
Podman host gateway and receive an explicit egress allow-list entry for that
host. Browser Host state updates refresh the gateway binding's sliding
lifetime, while the Browser Host remains the authority for capability checks.

## Consequences

- A prompt submitted before BrowserWorkbench provisioning completes waits for
  the browser session during auto-start; ordinary prompts can still run when
  browser provisioning fails.
- Browser tools are unavailable when no browser session is supplied, rather
  than silently operating on a global/shared browser.
- Browser Host capability refresh is still a separate lifecycle concern; the
  current session TTL bounds a single long-running browser workload.
- Worker image builds must include the canonical extension under the worker's
  own `node_modules` scope so Jiti resolves its Pi dependencies.
