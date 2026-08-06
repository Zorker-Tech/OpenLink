# ADR-0006: Preserve Pi sessions natively across Cloud and Local modes

## Status

Accepted

## Context

OpenLink runs the same Pi Agent through three execution transports: a Web OpenSandbox Worker, a desktop sandbox-runtime Worker, and a remote OpenSandbox RPC Worker reached over SSH. Pi's `SessionManager` natively persists an append-only versioned JSONL session containing a header and parent-linked entries for messages, model changes, compaction, branches, labels, and extension state.

Container or host-local JSONL alone is not a valid Cloud source of truth. A Web request may resume on another Agent Host, an OpenSandbox workload may expire, and remote execution storage may become unreachable. At the same time, reducing sessions to rendered chat text would lose Pi's branch, compaction, model, tool, and extension semantics.

## Decision

- Cloud mode stores the Pi session header and every native Pi session entry in PostgreSQL as structured `jsonb`. The tuple `(OpenLink session ID, Pi entry ID)` is idempotent and preserves Pi's parent-linked append-only graph.
- The Web OpenSandbox and remote SSH JSONL files remain execution caches. After every prompt, the Worker returns the newly appended native entries to the Web API, which persists them before considering the Cloud turn durable.
- A separate append-only `chat_session_events` table stores the normalized OpenLink UI event projection used by Chat UI. It is derived data and can be rebuilt from Pi-native data and runtime events; it is not the Agent session source of truth.
- Desktop Cloud mode uses the same PostgreSQL authority and sync protocol.
- Desktop Local mode keeps Pi JSONL as the sole authority and does not upload session contents unless the user explicitly migrates or switches that session to Cloud mode.
- Model provider and model IDs are persisted on the OpenLink chat session. A chat request must resolve an enabled user configuration; it must never silently fall back to an Agent Host default model.

## Consequences

### Positive

- Cloud sessions survive sandbox expiry, Agent Host replacement, and remote-host loss.
- Pi's native branch, compaction, model-change, and extension semantics remain available.
- Chat UI reloads from PostgreSQL instead of displaying an empty timeline.
- Execution transport and storage mode can change without changing the Pi session format.
- Explicit model choices remain stable across navigation, refresh, and subsequent turns.

### Negative

- Every Cloud turn performs additional PostgreSQL writes.
- Native entries and UI projections duplicate some content and require retention controls.
- Restoring a Pi JSONL file on a fresh Worker requires a materialization step from PostgreSQL, which is a follow-up to the initial append path.

### Neutral

- Local mode remains usable without network access, but local-only sessions are not visible on other devices.
- PostgreSQL encryption at rest protects the database volume; application-level field encryption remains limited to provider credentials unless session-content encryption is introduced later.

## Failure Modes and Mitigations

| Failure | Impact | Mitigation |
| --- | --- | --- |
| Sandbox expires | Runtime JSONL cache disappears | Re-materialize the Pi session from PostgreSQL before resuming |
| PostgreSQL write fails during a turn | Cloud turn is not durable | Fail the stream, retain mounted JSONL for retry, and use idempotent entry IDs |
| Duplicate Worker delivery | Entries may be replayed | Unique `(session_id, entry_id)` and `(session_id, event_id)` constraints |
| UI projection write fails | Timeline cannot safely resume | Do not acknowledge the projected event; rebuild from native entries/runtime log |
| Configured model is removed or disabled | Existing chat cannot execute | Return an explicit model-configuration error and require a new selection; never use host defaults |

## Alternatives Considered

**Store only Pi JSONL on Agent Host disks**

Rejected for Cloud mode because it couples durability to one machine and prevents reliable horizontal scheduling.

**Store only normalized chat messages in PostgreSQL**

Rejected because it discards Pi's native session graph, compaction, model changes, and extension entries.

**Store opaque JSONL blobs per completed turn**

Rejected because whole-file rewrites are expensive, conflict-prone, and difficult to query or deduplicate. Native entries are stored append-only as individual `jsonb` rows instead.

## References

- `services/pi/packages/coding-agent/src/core/session-manager.ts`
- `docs/architecture/ADR-0005-agent-worker-transports.md`
