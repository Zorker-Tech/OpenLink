# Browser Runtime Infrastructure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a production-shaped browser foundation that provides native iframe project preview, real-time Chromium interaction, component inspection, SSH-contained remote access, and one browser contract for web, desktop, and Pi.

**Architecture:** A standalone Node Browser Host owns sessions and privileged browser capabilities. OpenLink's Next.js UI consumes a pure protocol client and never launches Chrome or SSH. Managed project previews use a base-path-aware HTTP/WebSocket proxy with an injected Inspector Bridge; arbitrary pages use isolated Chromium plus a CDP screencast and serialized human/agent input.

**Tech Stack:** TypeScript, Node.js HTTP, WebSocket, Playwright Core/CDP, React 19, Next.js 16, iframe sandbox, SSH local forwarding.

---

### Task 1: Browser contracts and architecture decision

**Files:**
- Create: `docs/architecture/ADR-0004-browser-runtime-surfaces.md`
- Create: `lib/browser-runtime/protocol.ts`
- Create: `services/browser-host/src/protocol.ts`
- Test: `services/browser-host/test/protocol.test.ts`

Define versioned session, page, action, observation, event, control-lease, and
Inspector Bridge messages. Add runtime validation at every external boundary.

### Task 2: Browser Host authentication and lifecycle

**Files:**
- Create: `services/browser-host/src/auth.ts`
- Create: `services/browser-host/src/config.ts`
- Create: `services/browser-host/src/session-manager.ts`
- Test: `services/browser-host/test/auth.test.ts`
- Test: `services/browser-host/test/session-manager.test.ts`

Implement short-lived HMAC capability tokens, ownership checks, session expiry,
control leases, monotonic events, deterministic cleanup, and resource limits.

### Task 3: SSH forwarding and preview proxy

**Files:**
- Create: `services/browser-host/src/ssh-tunnel.ts`
- Create: `services/browser-host/src/preview-proxy.ts`
- Create: `services/browser-host/src/inspector-bridge.ts`
- Test: `services/browser-host/test/ssh-tunnel.test.ts`
- Test: `services/browser-host/test/preview-proxy.test.ts`

Spawn SSH without a shell, bind forwarded ports to loopback, verify readiness,
proxy HTTP and WebSocket traffic, require a configured preview base path, inject
the inspector bridge into HTML, and reject non-loopback upstream targets.

### Task 4: Complete Chromium runtime

**Files:**
- Create: `services/browser-host/src/chromium-runtime.ts`
- Create: `services/browser-host/src/browser-server.ts`
- Create: `services/browser-host/src/main.ts`
- Test: `services/browser-host/test/chromium-runtime.test.ts`

Launch a persistent isolated Chromium context, create and track pages, expose
structured DOM/accessibility observations, stream CDP screencast frames, map
pointer/keyboard/IME input, handle dialogs/downloads, and serialize human and
agent operations with the control lease.

### Task 5: Web Browser Workbench

**Files:**
- Create: `lib/browser-runtime/client.ts`
- Create: `components/browser/browser-workbench.tsx`
- Create: `components/browser/native-preview-surface.tsx`
- Create: `components/browser/chromium-stream-surface.tsx`
- Modify: `components/chat-workspace.tsx`

Add navigation controls, preview/interactive surface switching, connection and
error states, sandboxed native iframe rendering, Inspector Bridge selection,
real-time frame display, viewport-correct input forwarding, and safe cleanup.

### Task 6: Verification and operations

**Files:**
- Create: `services/browser-host/README.md`
- Create: `services/browser-host/package.json`
- Create: `services/browser-host/tsconfig.json`
- Modify: `services/README.md`

Run Browser Host tests and typecheck, then run the root TypeScript/Next build.
Document environment variables, SSH ownership, managed preview base-path
requirements, runtime ports, health checks, and local integration commands.

