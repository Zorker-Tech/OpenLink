# ADR-0034: First-Class Preview Targets and Web Annotation

## Status

Proposed

Date: 2026-11-07

Related: [ADR-0004](./ADR-0004-browser-runtime-surfaces.md),
[ADR-0011](./ADR-0011-browser-agent-session-binding.md),
[standard 12](./standards/12-live-browser-and-preview.md)

## Context

ADR-0004 already selects a sandboxed iframe for managed web previews and a
Chromium stream for arbitrary browser sessions. The Project preview proxy
provides an authenticated route, forwards HTTP and HMR WebSockets, and injects
the Inspector Bridge. noVNC is a separate desktop surface. The Preview product
direction should preserve those boundaries.

The current target picker is still chat-led. The browser API requires a chat
session, resolves its `project_id`, discovers servers across that Project's
active sandboxes, and ranks the current chat's server first. This permits
switching to another active session in the same Project, but does not make
Preview a workspace-level surface that can select a different repository,
worktree, standalone development server, or read-only URL without starting
from a chat.

The current Inspector Bridge can select and describe live DOM elements and
relay browser actions. It does not provide persistent annotation threads,
editable style state, layer navigation, theme-token controls, or a mapping from
a visual edit back to a source file. Its element references are scoped to the
running page and are not durable identifiers for saved comments or code edits.

### Product interaction requirements

The supplied interface shows an embedded Preview canvas with viewport and
navigation controls, plus Edit, Theme, and Layers tools. The screenshot is an
empty conversation, so it shows the controls and instructions rather than a
running app.

The interaction model should operate on the live app: select an element, make
visual adjustments that appear immediately, keep those adjustments pending
until applied, and turn an Apply action into a reviewable source change.
Annotations are a separate feedback mode: place numbered comments on the
preview and submit them together with their visual context. This ADR defines
OpenLink's target behavior and system boundaries.

OpenLink should separate the running web app from its display surface. A chat
may be associated with a Preview target or provide the preferred target, but it
must not be the only way to identify or open that target.

## Proposed Decision

1. Keep the iframe as the default renderer for OpenLink-managed web apps.
   Continue serving these targets through Browser Host's authenticated
   HTTP/WebSocket proxy and versioned Inspector Bridge. Use noVNC only for the
   full remote desktop surface. Use `chromium-stream` for sites or applications
   that cannot safely or reliably be embedded and proxied.

2. Introduce a Preview Target contract independent of a chat session. A target
   belongs to an authorized workspace or project and identifies its source
   provider, runtime environment, entry route, and supported capabilities. Its
   source binding is optional for viewing and annotations; code-edit capability
   requires an explicit editable checkout/worktree and revision. A chat/session
   id may be retained as provenance or a ranking hint, not as the target's
   identity or authorization boundary.

   Initial providers should cover the current Project sandbox server, an
   explicitly selected workspace/repository worktree server, and a read-only
   external URL. Provider URLs, proxy credentials, and runtime secrets remain
   server-side. Browser clients receive opaque target ids and safe labels. An
   external URL is never fetched by a general-purpose server-side proxy; if it
   cannot be embedded directly, open it in the isolated Chromium surface or a
   top-level tab without Inspector Bridge privileges.

3. Make Preview navigation state belong to the selected target and its viewport,
   not to an ephemeral Browser Host session. Recreating the iframe transport,
   changing chat tabs, or closing the Browser panel must not change the target
   or stop its development server. The chat that opened Preview can still be
   recorded as the initiating context.

4. Build visual tools as modes over the same live Preview document and bridge:

   - **Preview** renders the running app and supports responsive/device
     viewports, navigation, reload, and hot reload.
   - **Annotate** adds numbered comments anchored to a target revision, a
     screenshot, and a best-effort DOM locator/rectangle. Comments are sent to
     the selected agent/chat as one batch and do not mutate source code.
   - **Design** supports element selection, pending style edits, undo/redo,
     before/after, and natural-language instructions with a selected-element
     screenshot. Apply requires an editable source binding and sends a
     structured change request to the code-editing path. It must produce a
     reviewable source diff associated with that checkout/revision; direct DOM
     mutations remain temporary preview feedback.
   - **Theme** and **Layers** are capabilities of the Design panel, not separate
     browser runtimes. Theme controls may use project design tokens when the
     source adapter can identify them. Layers initially expose the live DOM
     hierarchy; component and source-file labels are enhanced metadata when an
     adapter can provide them.

5. Resolve and authorize every target server-side against workspace/project
   membership. Issue short-lived target capabilities for iframe requests and
   validate bridge messages against `event.source`, target/session identity,
   nonce, and allowed origin. Do not return upstream URLs, headers, or runtime
   credentials to the browser. A target without source-edit permission must
   never expose Design Apply, even if it supports read-only inspection or
   annotations.

6. Retain the Browser Protocol as the shared automation contract. Keep the
   agent's durable Chromium session independent from the UI-owned iframe
   session, as required by standard 12. Add Preview Target ownership alongside
   that protocol instead of making the agent browser session own Preview.

The proposed request and tool flow is:

```mermaid
flowchart LR
  W[Workspace, repo, or dev server] --> R[Authorized Preview Target resolver]
  R --> G[Browser Host preview proxy]
  G --> F[Sandboxed iframe]
  F <-->|versioned postMessage| B[Injected Inspector Bridge]
  B <--> U[Preview, Annotate, and Design tools]
  E[External or incompatible site] --> C[Chromium stream or top-level tab]
```

## Consequences

### Positive

- Managed web development uses native DOM rendering, preserving browser
  responsiveness, text selection, form behavior, and HMR without framebuffer
  transport overhead.
- Preview can be opened and reused across chats and repositories within the
  user's authorized workspace, with an optional connection back to a code-edit
  task.
- Annotation and Design can share one selection/bridge layer while keeping
  comments, temporary style previews, and source edits as distinct operations.
- A target with no editable checkout remains useful for viewing and feedback
  without implying that arbitrary sites can be changed.

### Negative

- Target ownership and lifecycle move from an implicit chat lookup to explicit
  workspace/project records and provider adapters.
- Durable annotations and source edits need stronger identity than the current
  page-local element reference; selectors can become stale after app updates.
- Framework-aware source mapping, design-token mapping, and code patching will
  be incomplete for some repositories. The UI must disclose when it can only
  send an instruction or screenshot.
- Iframe embedding still depends on managed proxy behavior, CSP, asset paths,
  cookies, and WebSocket handling. It cannot replace a full browser for every
  external site.

### Neutral

- Chat session remains useful as a default target hint and as the receiver of
  annotation or design instructions, but it no longer defines Preview's
  lifetime.
- The noVNC desktop remains available for native desktop applications and
  full-OS interaction; it is not involved in web Preview rendering.

## Alternatives Considered

### Render every Preview through noVNC

Rejected for web development. It streams pixels and input, adds CPU and
bandwidth cost, and does not provide the native DOM and bridge needed for
element-level inspection and annotations. It remains appropriate for Desktop.

### Keep Preview keyed only by the active chat session

Rejected as the product model. It is simple and matches the current API, but it
keeps the preview picker inside one Project and makes a standalone workspace,
worktree, or reusable preview dependent on a chat existing first.

### Put every arbitrary URL behind the managed preview proxy

Rejected. This would turn a server-side proxy into an unrestricted network
fetcher, would expose credentials and internal services to SSRF paths, and
cannot reliably rewrite CSP, workers, redirects, or WebSockets. Only explicitly
managed targets receive proxy and bridge privileges.

### Make visual edits directly in the live DOM

Rejected as a save model. It can show immediate feedback but is lost on reload
and cannot be reviewed or applied to the repository. DOM changes may be used as
temporary pending preview state before a source-aware Apply operation.

## Rollout Plan

1. **Preview target boundary:** define the provider-neutral target contract and
   workspace/project-scoped discovery and selection APIs. Adapt the current
   Project sandbox provider first; keep the current UI behavior as its default.
2. **Iframe Preview hardening:** preserve authenticated proxying, route and HMR
   support, capability isolation, target health/reload state, and viewport
   controls. Add explicit read-only external URL behavior and Chromium fallback.
3. **Web annotations:** extend the bridge for hover/selection geometry and
   stable-enough locators; add screenshot comments, batch submit, and target
   revision context.
4. **Design panel:** add pending style edits, undo/redo and before/after; then
   connect Apply to an editable worktree and show the resulting diff. Add Theme
   tokens and richer Layers metadata through source adapters.

Do not update binding standard 12 until this ADR is accepted and the first two
steps have an implementation contract. At that point, revise its target scope
from chat-led Project discovery to workspace/project authorization and record
the remaining code-edit requirements as follow-up decisions if needed.

## Validation Criteria

1. Open the same managed target from two chats with access to its workspace;
   target identity and dev-server lifetime remain stable.
2. Open two repositories/worktrees from one authorized workspace and switch
   between them without leaking either target's URL, headers, cookies, or
   runtime credentials to another target.
3. Confirm iframe navigation, reload, assets, cookies, and HMR WebSockets work
   through the authenticated path at desktop and mobile viewport sizes.
4. Confirm an external site that rejects framing is handled by the documented
   Chromium/top-level fallback and does not receive an injected bridge.
5. Add multiple annotations, submit them as one batch, and verify they retain
   screenshot, target revision, and best-effort locator context after reload.
6. Apply a Design edit to an editable worktree and verify a reviewable source
   diff; confirm read-only targets cannot invoke Apply.
7. Keep noVNC Desktop usable independently when Preview is opened or closed.

## References

- `components/browser/native-preview-surface.tsx`
- `services/browser-host/src/preview-proxy.ts`
- `app/api/browser/sessions/route.ts`
- `lib/browser-preview-targets.server.ts`
- `components/browser/desktop-workbench.tsx`
