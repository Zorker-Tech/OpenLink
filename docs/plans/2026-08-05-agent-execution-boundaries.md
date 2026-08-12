# Agent Execution Boundaries Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add independent OpenLink agent-host scaffolding that can run Pi in a
local sandbox-runtime or a remote OpenSandbox environment without coupling the
Next.js app to privileged execution.

**Architecture:** Keep Pi, OpenSandbox, and sandbox-runtime as vendored source
trees under `services/` using `git subtree`. Add an OpenLink-owned `services/agent-host`
package containing backend-neutral contracts, strict policy validation, Pi RPC
command construction, local and remote provisioning interfaces, and storage
layout helpers. The service remains a separate Node process and is excluded from
the root Next.js TypeScript project.

**Tech Stack:** Node.js >=22.19, TypeScript, Node standard library, Pi RPC
JSONL, OpenSandbox SDK/API, Anthropic sandbox-runtime, SSH transport supplied by
the host process.

---

### Task 1: Import upstream service history into the monorepo

**Files:**
- Create: `services/opensandbox` (subtree-imported source)
- Create: `services/sandbox-runtime` (subtree-imported source)
- Modify: `.gitmodules`

**Steps:**

1. Import each repository with `git subtree` at a reviewed source revision.
2. Record the commit and license in the service documentation.
3. Do not install dependencies or run lifecycle scripts during the vendoring
   step.
4. Verify there are no gitlink entries or nested `.gitmodules` files.

### Task 2: Create the independent agent-host package

**Files:**
- Create: `services/agent-host/package.json`
- Create: `services/agent-host/tsconfig.json`
- Create: `services/agent-host/src/index.ts`

**Steps:**

1. Define Node >=22.19 and keep the package outside the root pnpm workspace.
2. Expose only server-side imports and no React/Next dependencies.
3. Add typecheck and unit-test scripts that do not install or execute upstream
   lifecycle scripts.

### Task 3: Define backend-neutral contracts

**Files:**
- Create: `services/agent-host/src/contracts.ts`
- Create: `services/agent-host/src/errors.ts`

**Steps:**

1. Model local and SSH targets, policy, storage, agent launch, stream events,
   environment handles, and cleanup.
2. Ensure commands use argv arrays and environment maps rather than interpolated
   shell strings.
3. Add typed lifecycle states and error codes for provisioning, runtime, and
   transport failures.

### Task 4: Implement policy and storage layout helpers

**Files:**
- Create: `services/agent-host/src/policy.ts`
- Create: `services/agent-host/src/storage.ts`
- Test: `services/agent-host/test/policy.test.ts`

**Steps:**

1. Normalize and contain all paths beneath a session workspace/storage root.
2. Generate deny rules for credential files and an allow-only write policy.
3. Generate deterministic per-user/workspace/session storage directories.
4. Test traversal, absolute-path escape, forbidden credential paths, and stable
   session IDs.

### Task 5: Implement Pi RPC command and stream boundary

**Files:**
- Create: `services/agent-host/src/pi-rpc.ts`
- Test: `services/agent-host/test/pi-rpc.test.ts`

**Steps:**

1. Build a Node argv for Pi's `dist/rpc-entry.js` with explicit `--no-session`
   or a session path selected by the host.
2. Keep model/provider credentials out of argv; expose only an allowlisted env.
3. Validate LF-delimited JSONL frames and cap frame size.
4. Unit-test argv construction and malformed-frame rejection without spawning a
   real agent.

### Task 6: Add local and remote backend interfaces

**Files:**
- Create: `services/agent-host/src/backends/local-sandbox-runtime.ts`
- Create: `services/agent-host/src/backends/remote-opensandbox.ts`
- Create: `services/agent-host/src/ssh.ts`

**Steps:**

1. Define a `SandboxBackend` interface with preflight, provision, launch, and
   cleanup methods.
2. Local backend accepts an injected sandbox-runtime adapter and wraps Pi argv
   with `wrapWithSandboxArgv`.
3. Remote backend accepts an injected OpenSandbox SDK adapter and SSH transport;
   it only emits a validated bootstrap plan until target approval is supplied.
4. Make SSH commands argument-safe and explicitly reject shell fragments.

### Task 7: Add orchestrator and security documentation

**Files:**
- Create: `services/agent-host/src/orchestrator.ts`
- Create: `services/agent-host/README.md`
- Create: `docs/architecture/ADR-0003-agent-execution-boundaries.md`
- Modify: `tsconfig.json`

**Steps:**

1. Select local/remote backend based on an authenticated target descriptor.
2. Apply policy, storage, and Pi runtime contracts before provisioning.
3. Record lifecycle/audit events without secrets.
4. Exclude all `services/**` from the root Next.js TypeScript project.

### Task 8: Verify

**Steps:**

1. Run the agent-host unit tests.
2. Run agent-host typecheck.
3. Run `pnpm build` in the OpenLink root.
4. Run `git diff --check`.
5. Do not run remote SSH commands, Docker commands, or sandbox install scripts
   without a separately approved target and deployment plan.
