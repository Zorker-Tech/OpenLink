# Pi Chat Runtime UI

## Decision

The Chat UI consumes OpenLink-owned domain events, not Pi JSONL frames and not
Vercel AI SDK provider events directly.

```text
Pi RPC JSONL
  -> Agent Host (policy, sandbox, persistence, sequencing)
  -> PiEventAdapter
  -> OpenLinkAgentEvent v1 (NDJSON/SSE boundary)
  -> Chat timeline reducer
  -> AI Elements presentation components
```

Vercel AI SDK remains available for model/provider UI integrations, but it is
not the execution protocol. This keeps Pi replaceable and prevents browser code
from gaining SSH, local process, or sandbox authority.

## Event boundary

`OpenLinkAgentEvent` is versioned and carries a stable session id, event id,
monotonic sequence, timestamp, and source. The v1 vocabulary covers:

- session lifecycle;
- user and assistant message streams;
- reasoning streams;
- generic tools and shell commands;
- file changes, tasks, checkpoints, and plans;
- interactive confirmation requests;
- recoverable and terminal errors.

Pi `message_update` frames are deltas. Pi tool update frames are cumulative
snapshots. The adapter appends the former and replaces the latter. The UI treats
`agent_settled`, rather than `agent_end`, as the final run boundary because Pi
may still retry, compact, or process queued follow-ups after `agent_end`.

Outbound commands use the matching Pi RPC vocabulary: `prompt` (with explicit
`steer`/`followUp` behavior while streaming), `abort`, model/thinking changes,
and correlated `extension_ui_response` frames. Commands are encoded as one LF
terminated JSON record; generic line readers are not used because Pi permits
Unicode line separators inside JSON strings.

## Transport

The web transport is newline-delimited JSON so clients can validate and reduce
one complete event at a time without buffering a full response. Frames larger
than the Agent Host limit are rejected before reaching the web tier. Proxies
must disable buffering and caching.

The current Next.js route is explicitly a demo producer. It exercises the full
contract and Figma execution timeline while the production Agent Host adapter is
still dependency-injected. It does not claim to execute Pi. Production replaces
only the producer; the timeline and composer remain unchanged.

## Recovery and idempotency

- Event ids are unique within a session and sequences are monotonic.
- Reconnect clients resume after the last acknowledged sequence.
- Reducers upsert long-lived items by message, reasoning, tool, task, or
  confirmation id.
- Final message frames are authoritative and may replace accumulated deltas.
- Tool updates replace the current output snapshot rather than append it.
- Duplicate event ids must be ignored by the persistence/relay layer.

## Confirmation flow

Pi dialog-style `extension_ui_request` frames become
`confirmation.requested`. A user response becomes `confirmation.resolved` in
the UI and an `extension_ui_response` with the same Pi request id in Agent Host.
Fire-and-forget notifications become task or error events. Timeouts and process
disconnects resolve pending confirmations as cancelled.

## Security boundary

- Next.js and the browser never spawn Pi, SSH, Docker, OpenSandbox, or the local
  sandbox runtime.
- Agent Host authenticates the user/session, applies filesystem/network policy,
  provisions the selected backend, and owns process termination.
- Command input/output is treated as untrusted text and rendered without HTML.
- Confirmation is required before policy-expanding or destructive operations.
- Secrets, full environment variables, and unrestricted filesystem paths are
  removed from relayed events.

## Failure modes

| Failure | UI behavior | Host behavior |
| --- | --- | --- |
| Invalid/oversized JSONL frame | Recoverable error item | Stop and quarantine run |
| Network disconnect | Preserve timeline, show reconnecting | Keep bounded replay buffer |
| Pi retry/compaction | Update task item | Continue until `agent_settled` |
| Tool failure | Failed activity with output | Persist result and continue per Pi |
| Confirmation timeout | Mark cancelled | Send cancelled response |
| Host crash | Terminal error with restart action | Recover from persisted sequence |

## Figma mapping

The `45:1132` node defines a compact 13px execution log rather than a wide chat
bubble layout. User messages are right-aligned pills. Assistant prose is plain,
reasoning and tool steps use muted 24px rows, applied changes use an elevated
8px card, and completion metadata is separated by a checkpoint rule. Layout is
identical in light and dark modes; only semantic color tokens change.
