# Project VM Runtime Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make OpenLink start and use a complete project-scoped VM runtime from the repository's `services/linux` Podman source, with isolated OpenSandbox sessions and verified terminal/WebUI flows.

**Architecture:** The OpenLink supervisor starts the Agent Host and Browser Host. Each Project maps to one durable Linux VM (local Podman machine or remote QEMU/KVM over SSH). The VM owns the repository-built Podman engine, OpenSandbox control plane, Browser Host, toolchain, and project workspace. Each chat session is a separate OpenSandbox sandbox within its project VM; PostgreSQL remains the Cloud session/event authority.

**Tech Stack:** Node.js/TypeScript, Next.js, self-hosted Supabase/PostgreSQL, QEMU/KVM, Podman built from `services/linux`, OpenSandbox, Pi RPC/Node SDK, Browser Host.

---

### Task 1: Audit and define runtime invariants

**Files:**
- Modify: `docs/architecture/ADR-0008-remote-project-vm-runtime.md`
- Modify: `services/agent-host/README.md`
- Test: `services/agent-host/test/project-vm.test.ts`, `services/agent-host/test/ssh.test.ts`

Verify that the final runtime path never invokes host Docker Compose, every Project has a VM descriptor, every Session receives the owning Project runtime, and missing prerequisites fail explicitly.

### Task 2: Package the repository Podman engine

**Files:**
- Create: `scripts/build-podman-linux.mjs`
- Modify: `scripts/build-agent-remote-bundle.mjs`
- Modify: `services/agent-remote-release/project-vm.sh`
- Modify: `services/agent-host/src/remote-project-vm.ts`

Build a pinned Linux Podman engine from `services/linux`, include it with the remote bundle, install it automatically into each guest, and remove the guest's dependency on the distro `podman` package. Runtime support binaries are provisioned automatically and are validated before services start.

### Task 3: Remove host Compose from the Project VM deployment

**Files:**
- Modify: `services/agent-host/src/ssh.ts`
- Modify: `services/agent-host/src/backends/remote-opensandbox.ts`
- Modify: `scripts/build-agent-remote-bundle.mjs`
- Delete or isolate: `services/agent-remote-release/compose.yaml`

The final remote bootstrap uploads the verified bundle and VM helper only. In-VM services are started through Podman commands by `ProjectRuntimeManager`; the legacy host-level Compose route cannot be selected by the production remote profile.

### Task 4: Harden Project/Session lifecycle

**Files:**
- Modify: `services/agent-host/src/project-vm.ts`
- Modify: `services/agent-host/src/project-runtime.ts`
- Modify: `services/agent-host/src/prompt-http-server.ts`
- Modify: `services/agent-host/src/backends/local-opensandbox.ts`
- Modify: `services/agent-host/src/backends/remote-opensandbox.ts`

Ensure service images, sockets, ports, guest paths, credentials, health checks, stale containers, VM restart, and cleanup are all project-scoped and fail closed. A failed/exited service container must be recreated, not blindly started.

### Task 5: Clean state and start the complete local supervisor

Stop stale Agent Host/VM processes, remove old local session artifacts and the requested PostgreSQL session rows through Supabase MCP, rebuild all service artifacts from repository sources, and start `pnpm dev:local` with generated credentials and image archives.

### Task 6: Terminal interface coverage

Exercise health, authentication, project runtime provisioning, per-session sandbox creation, streamed Pi events, tool execution, session cleanup, browser session create/action/delete, invalid input, provider/model routing, persistence, and VM restart using direct HTTP/CLI calls. Query PostgreSQL after each durable boundary.

### Task 7: WebUI real smoke test

Using the in-app browser, create a new chat, send a real prompt, observe incremental stream events and tool execution, switch project/model, use Preview/Realtime Browser actions, refresh/reopen the session, and verify Draft grouping and persisted events. Capture evidence from the actual UI and service logs.

### Task 8: Final audit

Run Agent Host and Browser Host tests, TypeScript checks, Next build, image/runtime syntax checks, Supabase advisors, and a requirement-by-requirement architecture audit. Mark the goal complete only after both terminal coverage and WebUI smoke tests pass.
