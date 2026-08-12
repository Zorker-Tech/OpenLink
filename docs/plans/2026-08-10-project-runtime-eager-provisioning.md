# Project Runtime Eager Provisioning Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Start every Project VM when the Project is created and prevent conversations until its runtime is ready.

**Architecture:** Postgres stores a durable `waiting → active` lifecycle and a renewable provisioning claim. Agent Host reconciles pending runtime rows in the background using the existing idempotent runtime manager. Next.js renders runtime state and enforces readiness again when creating a chat.

**Tech Stack:** Next.js server actions, React, TypeScript Agent Host, PostgREST, self-hosted PostgreSQL/RLS, Local ZOKERBASE, Podman Project VM runtime.

---

### Task 1: Persist lifecycle and provisioning leases

**Files:**
- Create: `supabase/migrations/20260810090000_eager_project_runtime_provisioning.sql`

1. Extend Project status with `waiting` and make it the insert default.
2. Add claim, lease, attempt, and retry timestamps to `project_runtimes`.
3. Add a private trigger that synchronizes runtime state to Project state.
4. Backfill existing Projects from their current runtime rows.
5. Apply the migration to Local ZOKERBASE and verify constraints, triggers, and RLS.

### Task 2: Add the durable Agent Host reconciler

**Files:**
- Create: `services/agent-host/src/project-runtime-provisioner.ts`
- Modify: `services/agent-host/src/main.ts`
- Modify: `services/agent-host/src/remote-main.ts`
- Modify: `services/agent-host/src/index.ts`
- Test: `services/agent-host/test/project-runtime-provisioner.test.ts`

1. Write tests for atomic claiming, lease renewal, success, retry, and shutdown.
2. Implement a PostgREST queue client using only the server-side service key.
3. Reconcile claimed rows through `ProjectRuntimeManager.ensure` with bounded concurrency.
4. Renew leases during long VM initialization and release/schedule retry on completion.
5. Start and stop the reconciler with both Local and remote Agent Hosts.

### Task 3: Enforce readiness on chat creation

**Files:**
- Modify: `lib/projects.ts`
- Modify: `lib/chat-sessions.ts`
- Modify: `app/chat/actions.ts`

1. Return runtime status with every Project summary, including Draft.
2. Reject chat creation with `PROJECT_RUNTIME_NOT_READY` unless Project is active and runtime is ready.
3. Preserve workspace/project access checks and keep the database guard authoritative.

### Task 4: Render creating, waiting, and active states

**Files:**
- Modify: `components/new-project-dialog.tsx`
- Modify: `components/projects-workspace.tsx`
- Modify: `components/app-workspace.tsx`

1. Show `创建中` while the create action is pending.
2. Keep waiting Projects visible with a disabled card and initialization indicator.
3. Allow only active Projects in the chat Project selector.
4. Disable the default Draft composer while Draft is waiting and show the real reason.
5. Refresh waiting Project state until it becomes active or errors.

### Task 5: Verify complete lifecycle

1. Run Agent Host unit tests and production builds.
2. Create a personal workspace and verify Draft immediately enters waiting/provisioning.
3. Create an organization and verify its Draft initializes independently without delaying personal Draft.
4. Create a named Project and verify creating → waiting → active.
5. Prove the server rejects chat creation while waiting and permits it after ready.
6. Restart Agent Host during waiting and verify reconciliation resumes from the database.
