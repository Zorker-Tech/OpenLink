# Chat receipt and runtime decoupling

## Approved direction

Accept and display messages independently of optional Browser readiness and
Worker provisioning. Opening a session proactively warms its resources in the
background, but rendering and message receipt do not wait for that work.
Execution retains project isolation, ownership checks, access mode, and leases.

## Implementation boundary

- Start initial submission without awaiting BrowserWorkbench.
- Persist the canonical user event before opening the response stream; emit it
  before awaiting Agent Host startup.
- Keep preparation inside the managed response stream, with lease renewal,
  cancellation, a bounded preparation wait, and persisted terminal failures.
- Agent leases, resource discovery, and Browser start proactively in parallel.
- Browser binds to the warmed Worker independently; retry transient creation
  races without putting Browser readiness back on the message receipt path.
- Keep the initial-run URL marker until durable receipt.

## Verification

Test delayed Host startup, startup errors, cancellation, receipt ordering,
initial-turn replay, background prewarming, and dynamic browser binding.
Run targeted tests, Host typecheck, and production build.

## Deliberately separate

This is not a durable execution queue: leaving the page retains the existing
cancel-and-flush semantics. Surviving a full process restart with automatic
execution resumption requires durable turn jobs, claims, reconciliation, and
replay-safe agent execution. A background promise is not such a queue.
