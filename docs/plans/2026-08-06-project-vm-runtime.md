# Project VM Runtime Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give every OpenLink project a durable Podman-managed Linux VM, route all project sessions through that VM's OpenSandbox boundary, and bind unassigned chats to the workspace Draft project.

**Architecture:** The BFF resolves a chat's project before persistence. Agent Host owns a project VM manager and a real `podman machine` driver; the VM runtime descriptor selects the OpenSandbox and Browser Host endpoints for that project. Each session remains an ephemeral OpenSandbox workload and is cleaned up independently.

**Tech Stack:** Next.js server actions/routes, Supabase PostgreSQL + RLS, Node.js Agent Host, Podman machine CLI, OpenSandbox SDK, Browser Protocol.

---

### Task 1: Add project VM metadata and Draft invariants

**Files:**
- Create: `supabase/migrations/20260806170000_project_vm_runtimes.sql`
- Modify: `lib/projects.ts`
- Modify: `lib/chat-sessions.ts`
- Test: `services/agent-host/test/project-vm.test.ts`

Add `projects.is_default`, a unique partial default-project index, and the
one-to-one `openlink.project_runtimes` table with RLS policies derived from
workspace/project access. Backfill existing NULL `chat_sessions.project_id`
values to a workspace Draft project. Make `ensureDraftProject` race-safe and
resolve missing project IDs during chat creation.

### Task 2: Implement the real Podman machine driver

**Files:**
- Create: `services/agent-host/src/project-vm.ts`
- Modify: `services/agent-host/src/index.ts`
- Test: `services/agent-host/test/project-vm.test.ts`

Define a driver interface plus `PodmanMachineDriver` using `execFile` argument
arrays. Implement inspect, init, start, stop, remove, SSH command execution,
and toolchain bootstrap. The manager must persist/recover a project machine
name and return a typed project runtime descriptor; it must throw when Podman
is unavailable or a machine is not ready.

### Task 3: Propagate project identity through execution APIs

**Files:**
- Modify: `app/api/chat/[session_id]/events/route.ts`
- Modify: `app/api/browser/sessions/route.ts`
- Modify: `services/agent-host/src/prompt-http-server.ts`
- Modify: `services/agent-host/src/contracts.ts`
- Modify: `services/agent-host/src/backends/local-opensandbox.ts`
- Modify: `services/agent-host/src/backends/remote-opensandbox.ts`
- Modify: `services/agent-host/src/browser-client.ts`
- Modify: `services/browser-host/src/session-manager.ts`
- Modify: `services/browser-host/src/browser-server.ts`
- Modify: `packages/browser-protocol/src/index.ts`

Validate project IDs server-side, include them in metadata and runtime context,
and resolve the project VM descriptor before creating a session sandbox or
browser session. Never accept a client filesystem path or arbitrary endpoint.

### Task 4: Build the project runtime image/toolchain

**Files:**
- Modify: `services/agent-worker/Dockerfile`
- Create: `services/project-runtime/Containerfile`
- Create: `services/project-runtime/README.md`
- Modify: `scripts/dev-browser.mjs`

Build a versioned project runtime image with Git, Node/npm, corepack/pnpm,
Python, common compiler/build utilities, OpenSandbox server and Browser Host.
The image is loaded into each project VM and starts only project-scoped service
ports. Health checks must gate session creation.

### Task 5: Verify lifecycle, isolation and migration behavior

**Files:**
- Modify: `services/agent-host/test/project-vm.test.ts`
- Modify: `services/browser-host/test/browser-server.test.ts`
- Add: `docs/architecture/ADR-0007-project-vm-runtime-boundaries.md`

Run Supabase migration/advisors through the configured Supabase MCP, Agent Host
and Browser Host tests, `pnpm build`, and a local project creation → Draft chat
→ session sandbox lifecycle check. Verify one session cleanup leaves the VM and
another session's sandbox intact.

