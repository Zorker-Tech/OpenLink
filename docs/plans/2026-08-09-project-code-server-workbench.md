# Project Code-Server Workbench Implementation Plan

> **For Codex:** Implement and verify each task in the current workspace.

**Goal:** Embed a fully functional VS Code Web workbench for every chat Project while sharing the Project VM's `/workspace` with Agent workloads.

**Architecture:** A code-server container runs once per Project VM, bound only to its VM loopback port. Agent Host creates short-lived user/workspace/project bindings and reverse-proxies HTTP and WebSocket traffic through an authenticated path gateway. Next.js authorizes the chat owner server-side and the right workspace switches between browser and code surfaces.

**Tech Stack:** Next.js 16, React, Node.js HTTP/WebSocket proxy, code-server, Podman Project VM, OpenSandbox.

---

### Task 1: Finish the Project VM editor runtime

**Files:**

- Modify: `services/agent-host/src/project-runtime.ts`
- Modify: `scripts/build-project-runtime-images.mjs`
- Test: `services/agent-host/test/project-runtime.test.ts`

1. Ensure the code-server image loads and starts once per Project VM with the Project workspace mounted at `/workspace`.
2. Health-check the service and forward its VM loopback port only to Agent Host.
3. Verify existing Project VM port allocations upgrade without collisions.

### Task 2: Expose an authenticated editor session gateway

**Files:**

- Modify: `services/agent-host/src/code-server-gateway.ts`
- Modify: `services/agent-host/src/prompt-http-server.ts`
- Test: `services/agent-host/test/code-server-gateway.test.ts`

1. Add an authenticated `POST /v1/projects/:projectId/code-server/sessions` route.
2. Create a one-time bootstrap URL that exchanges for a path-scoped HttpOnly cookie.
3. Proxy HTTP and WebSocket requests without forwarding host credentials or leaking VM endpoints.

### Task 3: Connect the Next.js BFF and code view

**Files:**

- Create: `app/api/code-server/sessions/route.ts`
- Create: `components/code-server/code-server-workbench.tsx`
- Modify: `components/chat-workspace.tsx`

1. Authorize the current user against the target chat session before creating an editor binding.
2. Lazy-create the editor only when the Code toolbar action is selected.
3. Embed the gateway URL in the right panel; retain the Project Browser workbench for Preview and Realtime.

### Task 4: Verify the end-to-end Project boundary

**Files:**

- Test: `services/agent-host/test/prompt-http-server.test.ts`
- Test: `services/agent-host/test/code-server-gateway.test.ts`

1. Run the Agent Host unit suite.
2. Build the Next.js production bundle.
3. Build the code-server Project runtime image, provision a Project VM, and open the editor through the browser gateway.
4. Create a file in `/workspace` through code-server and verify the same Project VM can read it from an Agent session.
