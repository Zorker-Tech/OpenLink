# ADR-0031: Vite desktop host for Cloud and self-hosted instances

## Status

Accepted. Supersedes [ADR-0024](./ADR-0024-electron-desktop-shell.md).

## Context

OpenLink has two deployment surfaces for product data:

1. **Cloud** — the vendor-hosted OpenLink instance, authenticated with Hydite.
2. **Self-hosted** — an operator-installed OpenLink instance, including one
   running on the same machine as the desktop client (`http://127.0.0.1:3000`).

The desktop client previously loaded the remote instance's Next.js pages. That
made the desktop UI version equal to the server version, prevented a native
connection switcher, and offered no consistent desktop surface.

An earlier iteration also made the desktop install and supervise the sealed
self-hosted runtime (Zokerbase/Postgres, GoTrue, agent-host, browser-host, and a
Project VM). That was removed after implementation and verification: it turned
a desktop client into a server installer and operator surface. It required
Docker/Podman, KVM/Hyper-V/AppleHV, a 24 GB Project VM, system services, and
administrator privileges; a true local-first product would also require a
second SQL schema and a second auth/data layer maintained alongside every
feature. That is a different product, not a desktop mode.

The existing UI is portable: pages are thin server components that pass data to
large client components. The only Next-specific imports in shared UI are
`next/navigation`, `next/link`, and the server-action modules.

## Decision

### 1. The renderer is a Vite SPA

`desktop/src/renderer` is the only desktop renderer. It consumes
`components/`, client-safe `lib/`, `public/`, and the product stylesheet
verbatim. Vite aliases resolve:

- `next/navigation` and `next/link` to a small host router;
- each `@/app/**/actions` module to a fetch wrapper;
- `@` to the repository root.

No shared component is forked. Web keeps its Next imports and behavior.

### 2. Desktop is a client, not a server host

The desktop keeps two profile kinds:

- `cloud` — the vendor Cloud, Hydite login;
- `remote` — any self-hosted instance, including localhost.

The desktop does **not** install, start, stop, upgrade, back up, or restore a
server runtime. A user who wants a server on the same machine installs the
sealed self-hosted release with its own installer/`openlinkctl`, then adds
`http://127.0.0.1:3000` as a self-hosted profile. This preserves local usage
without making the client an operator surface.

A first run with no profile opens a setup surface served by a loopback setup
gateway. Adding the first server connects immediately.

The desktop has no marketing home route. `/` resolves the app entry: anonymous
sessions go to login, new users go to onboarding, and existing users go to their
workspace. The web application keeps its marketing home page.

### 3. The server remains the single Next.js BFF

The desktop API is an additive, versioned namespace:

- `GET /api/desktop/v1/capabilities`
- `GET /api/desktop/v1/bootstrap/[[...path]]`
- `POST /api/desktop/v1/actions`
- `POST /api/desktop/v1/auth/hydite/exchange`

The bootstrap loaders reuse the same server-side domain functions as the
corresponding pages. The action bridge calls the existing server-action
functions; validation, authorization, and persistence are not duplicated.
Existing pages, server actions, route handlers, `proxy.ts`, and RSC rendering
are unchanged.

### 4. A loopback gateway owns the renderer origin

Electron main starts an HTTP server on `127.0.0.1` that:

- serves the Vite build and public assets;
- reverse-proxies `/api/*` and `/auth/*` to the active profile's upstream;
- streams SSE and tunnels WebSocket upgrades;
- rewrites `Set-Cookie` to the loopback origin and `Location` back to the
  gateway origin;
- rejects a foreign `Host` (DNS rebinding), a foreign `Origin` on
  state-changing requests, and path traversal;
- rewrites loopback alias redirects (`localhost` ↔ `127.0.0.1`) when the port
  matches the upstream, so a self-hosted server that canonicalizes its origin
  does not navigate the window away from the gateway.

The renderer always uses relative URLs. CORS never applies, session cookies are
first-party, and profile switching changes only the upstream. Each profile uses
its own Electron session partition so credentials never cross profiles.

### 5. Authentication

- **Email/password and email confirmation** use the shared Supabase browser
  client through the gateway, so cookies are first-party.
- **Hydite (Cloud)** uses `@vtslx/platform-sdk/auth` as a public OAuth PKCE
  client. The system browser performs the interactive flow. Electron main owns
  a one-shot loopback listener and returns only the authorization code to the
  renderer. The renderer exchanges the code with the PKCE verifier and posts
  the ID token to `/api/desktop/v1/auth/hydite/exchange`, where Supabase
  verifies the token and creates the same session the web login creates. Tokens
  never appear in the URL bar or the main process.
- **Self-hosted** uses that instance's own auth. Redirect-based flows require
  the instance to allow the desktop loopback origin; instances that ship this
  release include the compatible contract.

### 6. Compatibility is explicit

`/api/desktop/v1/capabilities` returns the API version, minimum desktop
version, server version, feature list, runtime mode, and public Supabase/Hydite
configuration. V1 is additive. A breaking change requires v2 and a compatibility
window. A desktop that predates an endpoint, or a server that predates the
desktop contract, produces a capability mismatch with a connection/setup
surface instead of a blank page.

### 7. Security boundaries

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- The preload exposes a narrow, explicit IPC bridge.
- The gateway binds loopback only and validates `Host` and `Origin`.
- No provider API key, service-role key, or runtime secret enters the renderer.
- The renderer never receives Node, filesystem, or arbitrary Electron APIs.

### 8. Local-first is a separate product

A single-machine OpenLink with embedded SQL, local auth, and a lightweight
sandbox is not a mode of this client or of the self-hosted server. If that
product is pursued, it needs its own schema, auth, sandbox, migrations, and
release, and it must not fork the server data contract implicitly.

## Consequences

### Positive

- One product UI serves web, Cloud desktop, and self-hosted desktop.
- Web architecture and rendering remain unchanged.
- The desktop opens directly to login, onboarding, or the workspace; there is
  no marketing page to maintain in the client.
- The desktop has no Docker, KVM/Hyper-V, system-service, or administrator
  requirement; installation surface and support burden are much smaller.
- Localhost usage still works through the self-hosted installer and a normal
  remote profile.
- Profile switching has a clear credential boundary.

### Negative

- Self-hosted instances must expose the desktop API; older instances need an
  upgrade or a web-UI compatibility fallback.
- The desktop no longer offers one-click local installation. That is deliberate.
- A future local-first product will need a separate architecture and release.

### Operational

- A stable loopback port (default `43126`) keeps Supabase's host-derived cookie
  names stable across restarts.
- `OPENLINK_DESKTOP_AUTH_PORT` (default `43127`) is the Hydite loopback
  callback and must be allowed by the Cloud OAuth client.
- A self-hosted server on localhost is managed by its own installer/`openlinkctl`,
  not by the desktop.

## Alternatives considered

- **Bundled desktop local runtime.** Implemented and verified, then removed:
  it is a server installer and operator surface, not a desktop client. It
  required Docker/Podman, a hypervisor, a 24 GB VM, system services, and
  administrator privileges, and it would have required a second SQL/auth layer
  for a true local-first product.
- **SQLite local adapter inside this client.** Rejected: 98 data queries, 18
  RPCs, 71 auth calls, and 12 Postgres-specific migrations would need a parallel
  implementation; every future feature would need local SQL and desktop-local
  APIs. This is a second product, not a mode.
- **Keep the thin Next.js shell (ADR-0024).** Rejected: it cannot offer a native
  connection switcher or a consistent desktop surface.
- **Load the remote Next.js UI in desktop.** Rejected: the desktop UI becomes
  coupled to the server release.
- **Fork product components for desktop.** Rejected: it recreates the drift
  this ADR is intended to prevent.
