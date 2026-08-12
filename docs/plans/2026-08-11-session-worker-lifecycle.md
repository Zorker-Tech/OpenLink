# Session Worker Lifecycle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep each Project VM resident while warming the selected chat's Agent Worker on session entry, pausing idle workers instead of deleting them, and resuming them before the next prompt.

**Architecture:** Project VM lifecycle remains owned by `ProjectRuntimeManager` and is never stopped by chat/session idle cleanup. Agent Host owns a per-chat Worker runtime map: the chat lease endpoint materializes a Worker before the user sends a message, the idle reaper pauses it, and a later lease/prompt resumes the paused sandbox. Existing Pi session JSONL is uploaded through OpenSandbox's filesystem API instead of being embedded in a shell argument, so long sessions do not hit `E2BIG`/`argument list too long`.

**Tech Stack:** Next.js server routes, Supabase/ZOKERBASE server client, TypeScript Agent Host, OpenSandbox Node SDK, React chat workspace.

---

### Task 1: Document and test the lifecycle contract

**Files:**
- Create: `docs/architecture/ADR-0015-session-worker-lifecycle.md`
- Modify: `services/agent-host/test/prompt-http-server.test.ts`

1. Record the separation between resident Project VMs and pausable chat Workers.
2. Define lease warmup as idempotent and prompt-safe; a legacy lease without a runtime configuration remains a touch-only heartbeat.
3. Define paused workloads as recoverable by the in-process Agent Host and ensure local stale cleanup preserves paused workloads.
4. Add a prompt-server test proving a lease containing runtime configuration calls `createSession` once and a repeated lease reuses it.

### Task 2: Restore large native sessions through the filesystem API

**Files:**
- Modify: `services/agent-host/src/backends/local-opensandbox.ts`
- Modify: `services/agent-host/src/backends/remote-opensandbox.ts`
- Test: `services/agent-host/test/local-opensandbox.test.ts`

1. Serialize the Pi header and entries once as UTF-8 JSONL.
2. Call `sandbox.files.writeFiles` with the mounted session path and a worker-readable mode; do not interpolate session contents into `commands.run`.
3. Keep the existing directory preparation and return a bounded `AgentHostError` when the upload fails.
4. Add a regression test/diagnostic fixture larger than the platform argument limit.

### Task 3: Add pausable Worker sessions to Agent Host

**Files:**
- Modify: `services/agent-host/src/prompt-http-server.ts`
- Modify: `services/agent-host/src/backends/local-opensandbox.ts`
- Modify: `services/agent-host/src/backends/opensandbox-recovery.ts`
- Modify: `services/agent-host/src/backends/remote-opensandbox.ts`
- Modify: `services/agent-host/test/prompt-http-server.test.ts`

1. Extend the prompt runtime contract with optional `pause` and `resume` operations.
2. Make the local OpenSandbox session hold a mutable sandbox/endpoint handle; `resume` reconnects to the refreshed endpoint and rechecks `/healthz` before serving prompts.
3. Change local idle reaping from destructive delete to pause; retain the entry for fast resume. Cleanup remains available for model replacement and shutdown.
4. Preserve paused local workloads during Agent Host restart recovery; running/creating stale workloads remain deletable.
5. Return explicit warmup status from the lease endpoint and keep model/browser identity locking intact.

### Task 4: Warm Workers when a chat page opens

**Files:**
- Modify: `app/api/chat/[session_id]/lease/route.ts`
- Modify: `components/chat-workspace.tsx`

1. Resolve the session's configured provider/model and Pi snapshot server-side, and send them to Agent Host in the lease warmup request.
2. Include the current Browser Host session id when it is available, so the prewarmed Worker has the same browser capability as the first prompt.
3. Trigger lease warmup on initial session mount, after browser session binding, and on the existing keepalive interval.
4. Keep the UI usable while warmup is pending; the first prompt remains an idempotent fallback.

### Task 5: Verify the complete behavior

1. Run Agent Host unit tests and TypeScript checks.
2. Run the long-session restore diagnostic and confirm the Worker command follows the file upload without `argument list too long`.
3. Open an existing long chat and confirm its Worker is warmed before sending a prompt.
4. Let the Worker idle, confirm the sandbox becomes `Paused` while the Project VM remains `ready` and its service containers stay running.
5. Reopen the chat and confirm the sandbox resumes without provisioning a new Project VM.
6. Rebuild/restart the local application and verify the VM is not stopped as part of session idle handling.
