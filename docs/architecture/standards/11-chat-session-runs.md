# 11 — Durable chat session runs

Status: binding
Owner: chat runtime

A chat turn is a durable session run, not a property of the browser tab that
started it. The NDJSON response is a transport for a live viewer; it does not
own the Agent execution.

## Records

`openlink.chat_session_runs` stores one row per turn:

```text
run_id, session_id, user_id, process_id, status,
started_at, heartbeat_at, finished_at, error_code
```

`status` is `running | completed | failed | cancelled`. `process_id` is the
same capability holder used by the session lease; it identifies the process
that owns execution. A running row with a heartbeat older than 90 seconds is
rendered as `interrupted`.

`openlink.chat_sessions.labels` is a durable text array owned by the session.
The session title and labels are always read from the session record, never
from the currently open tab.

## Background execution

- The BFF starts the run only after the canonical user event is durable.
- A browser disconnect marks the local consumer detached. It does not cancel
  the Agent request, abort the upstream read, or release the session lease.
- The BFF continues consuming Agent events, persisting them, and refreshing the
  run heartbeat until a terminal Agent state.
- Explicit stop remains an API action (`/control`, action `interrupt`); page
  navigation is not an interrupt.
- On reopen, the page reads the latest run and persisted events through
  `GET /api/chat/:session_id/run`. A running session tails new events until the
  run is terminal.
- Completion or failure closes the run before the lease is released.

A Next.js process crash is detected by the heartbeat and displayed as
`interrupted`; it is not silently reported as running. Resuming a crashed
in-flight turn requires a separate durable job runner and is not implied by
this record.

## UI binding

- The sessions sidebar binds every row to that session's latest run status and
  process, not only to the active route.
- The chat title is initialized from the session record and refreshed after a
  rename or automatic title update.
- The right workspace header shows the same session title and current run
  status.
- Reopening a running session blocks a second prompt until the run reaches a
  terminal state or the user explicitly interrupts it.

## Validation

1. Start a turn, disconnect the HTTP stream before completion, and observe the
   run remain `running`, then become `completed` with a terminal event.
2. Reload the session page while the run is active and observe persisted events
   and status without a second prompt.
3. Explicit `interrupt` terminates the run and records `cancelled`.
4. A stale heartbeat is shown as `interrupted`, never as an indefinitely
   running process.
5. Two sessions maintain independent statuses and process ids in the sidebar.
