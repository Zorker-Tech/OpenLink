# ADR-0015: Keep Project VMs Resident and Pause Idle Session Workers

## Status

Accepted

## Context

OpenLink has two different runtime scopes:

- A Project VM owns the project workspace and its long-lived services (OpenSandbox, Browser Host, code-server, and the project filesystem).
- An Agent Worker owns one chat session's Pi process and provider/browser capability bindings.

Treating those scopes as one lifecycle made opening a chat slow and made an idle chat risk stopping the project runtime. A session can be idle while the project still needs to be immediately available for the next chat or code view. Long Pi histories also cannot be passed through a shell command argument: a sufficiently large JSONL snapshot exceeds the guest `ARG_MAX` limit.

The required behavior is that an application-running Project VM is never physically powered off as a consequence of chat inactivity. Workers should be ready before the first prompt, may release execution resources while idle, and must be resumable without reprovisioning the Project VM.

## Decision

1. `ProjectRuntimeManager` remains the owner of Project VM and project-service lifecycle. Chat lease cleanup must not stop or delete a Project VM.
2. `PromptHttpServer` owns an in-memory Worker lease per `(user, workspace, chat session, provider/model revision, browser session)`. A lease is idempotent:
   - a lease with runtime configuration provisions the Worker during chat-page warmup;
   - a legacy lease without runtime configuration only refreshes an existing lease and never provisions a Worker.
3. The idle reaper pauses Workers that implement `pause()` and retains their session entry. It resumes the same sandbox before a prompt or warmup lease. Backends without pause support retain the previous destructive cleanup fallback.
4. Local and remote OpenSandbox backends implement `pause()` and `resume()` around the sandbox handle. Resume reconnects to the refreshed endpoint and waits for Worker `/healthz` before serving traffic. `cleanup()` remains destructive and is reserved for model/browser identity replacement, failed recovery, explicit shutdown, and stale workloads from a previous Agent Host process.
5. The chat page sends a warmup lease after the Browser Host binding is connected (or definitively unavailable) and refreshes it periodically. The first prompt remains safe if warmup failed because prompt creation is idempotent and can rebuild from the durable Pi snapshot.
6. Pi native session snapshots are serialized as UTF-8 JSONL and uploaded through the OpenSandbox filesystem API. Filesystem permission values use the API's octal-digit representation (`777`, `666`), not JavaScript numeric octal literals (`0o777`, `0o666`). Shell arguments are never used for the full snapshot payload.
7. Application shutdown may clean up Agent Workers and close the Agent Host transport, but Project VM shutdown is a separate explicit lifecycle operation. Normal session idle handling only pauses Workers.

## Consequences

### Positive

- Opening a chat starts its Worker before the user sends a message.
- Returning to an idle chat resumes the existing sandbox without rebuilding the Project VM or project services.
- Project VM state, browser sessions, code-server, and `/workspace` remain independent from chat-worker idleness.
- Large Pi histories no longer fail with `E2BIG`/`argument list too long`.
- Provider/model/browser changes remain isolated by the lease identity key.

### Negative

- Paused Worker sandboxes remain allocated in the OpenSandbox control plane until the Agent Host explicitly cleans them up.
- The Agent Host must keep a live in-memory handle for fast resume; a process restart cannot transparently resume an orphaned handle without a durable sandbox-id registry.
- Keeping Project VMs resident consumes host resources; future resource-pressure policy must be explicit and must distinguish sleep from physical shutdown.

### Neutral

- The existing session idle TTL still controls when a Worker is paused.
- Project VM readiness and Worker readiness are reported independently.

## Alternatives Considered

### Delete idle Workers and recreate them on the next prompt

Rejected because it repeats image startup, capability setup, and session restoration on every return, which is the source of the observed long `Thinking…` delay.

### Stop the Project VM when its last chat is idle

Rejected because it also interrupts code-server, Browser Host, project services, and workspace availability. It violates the requirement that an application-running Project VM is either running or suspended, never physically powered off by chat cleanup.

### Keep every Worker running indefinitely

Rejected because each session consumes a full Worker container and its execution resources. Pausing preserves state while releasing active execution resources.

## References

- `services/agent-host/src/prompt-http-server.ts`
- `services/agent-host/src/backends/local-opensandbox.ts`
- `services/agent-host/src/backends/remote-opensandbox.ts`
- `app/api/chat/[session_id]/lease/route.ts`
- `components/chat-workspace.tsx`
