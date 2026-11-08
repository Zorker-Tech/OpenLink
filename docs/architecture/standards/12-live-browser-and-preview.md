# 12 — Live Browser and Preview targets

Status: binding
Owner: browser runtime

The Live Browser is an Agent capability, not a child of the Browser tab. The
Preview surface is a user discovery and viewing surface over an authorized
workspace Project runtime. They are separate ownership domains. The Preview
entry is the Preview tab in the existing chat workspace; a chat can provide a
default target hint, but does not own the target or its development server.

## Agent-owned Browser session

Every Agent runtime created by Agent Host receives one stable Chromium Browser
session:

- Surface: `chromium-stream`; profile key: the chat session id.
- The capability is created during Agent session provisioning, before any
  Browser tab is open, so the Agent can launch and drive the browser itself.
- The session is not registered with the public gateway until a user opens the
  Realtime surface.
- The Web UI never binds the Agent to its transient `native-preview` session
  and never deletes the Agent's Chromium session on unmount, tab hide, pause or
  workspace switch.
- Browser Host's session TTL is the only idle reaper. Agent actions refresh the
  same TTL.
- Opening Realtime uses the same profile key, so Browser Host returns the
  existing session rather than launching a second Chromium profile.

The Agent control token is delivered only through the session capability file.
The browser-facing gateway token is separate and never returned to the Agent.

## Agent browser tools

Pi and Codex expose the same capabilities. Minimum surface:

`browser_pages`, `browser_open`, `browser_close`, `browser_activate`,
`browser_read`, `browser_navigate`, history (`back`/`forward`/`reload`),
`browser_click`, `browser_hover`, `browser_type`, `browser_insert_text`,
`browser_drag`, `browser_key`, `browser_scroll`, `browser_screenshot`, and
`browser_dialog`.

`page.list` is a real Browser Host action and is supported by both the
Chromium and native preview runtimes. A tool must not invent a page id; it
calls `browser_pages` first when the id is unknown.

## Preview target discovery

A user may select any authorized code Project in the current workspace from the
Preview tab. Project access and target liveness are rechecked server-side on
every discovery and session creation. The browser profile stores the selected
Project and opaque target preference by user and workspace; the validated page
pathname and desktop/mobile viewport are stored per target. None of these
preferences contain upstream URLs, credentials, query strings, or fragments.

Managed targets can come from active Project sandboxes or a detached commit
worktree. A Project may run several OpenSandbox session sandboxes, each with
several development servers. `ProjectRuntimeManager.discoverPreviewTargets()`:

- lists active sandboxes for the Project;
- probes a bounded conventional port set concurrently through the authenticated
  OpenSandbox proxy;
- records the owning `openlink.session_id` and ranks the current chat session
  first;
- returns opaque target ids (`<sandboxId>:<port>`) plus a safe label/port.

The public list endpoint returns opaque ids, labels, ports and session hints
only. The proxy URL and `OPEN-SANDBOX-API-KEY` remain inside Agent Host.
Browser session creation resolves the selected id inside Agent Host. Worktree
targets are created from a validated commit ref, mounted into a separate
egress-denied OpenSandbox workload, and start a package's `dev` or `start`
script when its manifest declares a supported Node web framework. The checkout
lives in a mode-restricted Project VM directory outside the editable workspace;
only its validated path is mounted. Existing Project dependencies are reused.
They receive no provider credentials. Their content-derived revision is
attached to screenshot receipts. Design Apply remains disabled until a code
session is explicitly bound to that worktree.

External URLs are entered explicitly in the Preview address bar and loaded
directly by the user's browser in a separate iframe sandbox. Dotted hostnames
over HTTP(S) are accepted; localhost-like names, IP literals, credentials, and
unsupported schemes are rejected. The frame has no
`allow-same-origin`, popups, or Inspector Bridge. The server never fetches an
external URL. A top-level link is available when the site rejects framing.
External URLs are not persisted with Preview state.

## Preview UI

- The Preview toolbar lists every discovered target and can refresh the list.
- The Git version menu creates or reuses an isolated worktree Preview target;
  selecting Latest returns to a managed Project target. Historical worktrees
  do not mutate the shared Project checkout.
- Selecting a target recreates the native Preview tunnel with the correct
  upstream headers. Only native Preview sessions are UI-owned and released on
  switch/unmount.
- An explicit current-session target is labelled as such; other sessions are
  shown as other active dev hosts.
- The Preview target id is persisted by user and workspace, independent of the
  current chat. Its safe pathname and desktop/mobile viewport are persisted per
  target. The server still re-resolves the target before opening its proxy.

## Validation

1. Start two dev servers in one sandbox and one in another active session;
   all three appear and the current session ranks first.
2. Select an alternate target and observe the Preview render that server.
3. Stop a target, refresh, and observe it disappear; selecting a stale target
   returns a recoverable `PREVIEW_TARGET_NOT_FOUND`.
4. Start an Agent turn without opening any Browser tab; `browser_pages` and
   `browser_open` succeed and the page is visible after opening Realtime.
5. Hide or close the Browser tab; the Agent's Chromium session remains usable.
6. The Preview target list never contains proxy URLs or API keys.
7. Open the same Project from two chats and confirm the chosen target, pathname,
   and viewport restore from the same browser profile while target authorization
   is checked again by the server.
8. Switch Git versions and confirm a detached worktree target appears without
   changing the shared checkout; confirm revision receipts match that worktree.
9. Open an external domain, verify it has no bridge access or persisted URL,
   and verify localhost, IP-literal, credential-bearing, and unsupported URLs
   are rejected.
