# ADR-0010: Lease and order Cloud chat session execution

## Status

Accepted

## Context

Cloud chat requests can be routed to different Web or Agent Host processes. Pi
sessions are append-only, but two requests for the same OpenLink session must
not drive the same Pi leaf concurrently. A crashed request must also become
recoverable without an operator deleting a sandbox. Finally, Pi's JSONL order
is part of the native session semantics; timestamps alone are not a stable
ordering key when multiple entries share one millisecond.

## Decision

- `openlink.chat_session_leases` is the database authority for one active Cloud
  prompt per `(user, chat session)`. The holder is an opaque random request ID.
- A lease is acquired only after authentication, model resolution, and session
  validation. The stream renews it every minute and releases it on normal
  completion, upstream failure, downstream cancellation, or request abort.
- Worker cancellation is a control request, not an immediate TCP abort. The
  BFF calls Agent Host's authenticated cancel endpoint; Agent Host calls the
  worker cancel endpoint and drains the worker response long enough to receive
  the final `openlink_session_entries` frame. A bounded safety timer still
  aborts a wedged worker.
- A lease expires after a crash, so a later request can recover the Project VM
  and materialize the Pi session from PostgreSQL.
- Native Pi entries are persisted with a per-session `entry_order` assigned in
  append order. Replayed entry IDs are ignored idempotently; reopened workers
  always load by this ordinal rather than by timestamp.
- Normalized `chat_session_events` remain a UI projection and use an atomic
  reserved sequence range per stream.

## Consequences

- Cloud prompts remain single-writer while allowing multiple Agent Host
  instances and recoverable failover.
- Long-running tool calls do not silently lose exclusivity at the initial lease
  TTL boundary.
- Reopening a session reconstructs the same Pi leaf and parent path instead of
  depending on nondeterministic timestamp ties.
- A short-lived stale lease can return `SESSION_BUSY`; clients should retry
  with backoff after the lease expires.

## Failure modes and mitigations

| Failure | Mitigation |
| --- | --- |
| Web request crashes | Database lease expiry makes the session recoverable. |
| Browser disconnects | Cancel handlers stop the worker, drain its native-session delta, and release the lease. |
| Lease renewal fails | The stream is aborted fail-closed before another writer can proceed. |
| Duplicate native delta | Existing Pi entry IDs are checked and ignored. |
| Equal Pi timestamps | `entry_order` is persisted and used for materialization. |
