# OpenLink Desktop

Electron shell with a Vite renderer that shares the product UI with the Next.js
web application. See [ADR-0031](../docs/architecture/ADR-0031-desktop-vite-host.md)
for the architecture decision.

OpenLink Desktop is a **client** for Cloud and self-hosted instances. It does
not install or supervise a server runtime on the user's machine. A server
running on the same machine is added as a normal self-hosted profile
(`http://127.0.0.1:3000`).

## Profiles

| Profile | Server | Authentication |
| --- | --- | --- |
| `cloud` | The vendor-hosted OpenLink Cloud | Hydite via the platform SDK |
| `remote` | Any self-hosted instance, including localhost | The instance's own auth (email/password) |

Profiles are managed from **File → Connections…** (`Cmd/Ctrl+,`). Each profile
uses an isolated Electron session partition. Switching recreates the window and
the loopback gateway. On first run, the app opens the setup surface; adding the
first server connects immediately.

The desktop client has no marketing home route. `/` resolves the app entry:
anonymous sessions go to login, new users go to onboarding, and existing users
go to their workspace.

## Runtime architecture

```text
Electron main
├─ Profile store (userData/profiles.json)
├─ Connection manager (cloud | remote)
├─ Desktop auth broker (Hydite PKCE loopback)
└─ Gateway 127.0.0.1:<port>
   ├─ /            Vite renderer build
   ├─ /api/*       active profile upstream
   ├─ /auth/*      active profile upstream
   └─ /__openlink/health
```

The renderer only uses relative URLs. The gateway provides a single first-party
origin for cookies, SSE, and WebSocket traffic, and rewrites upstream
`Set-Cookie`/`Location` headers back to the loopback origin. A first run with no
profile uses a setup gateway and the connection panel.

## Shared UI

`vite.config.mjs` aliases:

- `next/navigation` → `src/renderer/platform/navigation.tsx`
- `next/link` → `src/renderer/platform/link.tsx`
- `@/app/**/actions` → `src/renderer/platform/actions/*`
- `@` → the repository root

No shared component is forked. The only shared-component change is the optional
`onPlatformLogin` prop on `components/auth-page.tsx`, which is unused by web.

## Server contract

The desktop API is additive and versioned under `/api/desktop/v1`:

- `GET /capabilities` — API version, features, runtime mode, public config
- `GET /bootstrap/[[...path]]` — page data for the Vite router
- `POST /actions` — allowlisted bridge to the existing server actions
- `POST /auth/hydite/exchange` — Supabase ID-token exchange for Cloud login

The web application keeps its RSC pages, server actions, and existing route
handlers unchanged.

## Development

```bash
npm --prefix desktop install
# Start a self-hosted server (or Cloud) separately, then:
OPENLINK_DESKTOP_URL=http://127.0.0.1:3000 npm --prefix desktop run dev
```

`OPENLINK_DESKTOP_UPSTREAM` selects the Vite dev proxy target (default
`http://127.0.0.1:3000`). `OPENLINK_DESKTOP_RENDERER_URL` lets Electron load the
Vite dev server directly; the gateway is only used for packaged builds.

## Verification

```bash
pnpm desktop:build        # Vite renderer build
pnpm desktop:test         # gateway, profiles, auth broker
pnpm desktop:typecheck    # desktop renderer + desktop API types
pnpm desktop:e2e          # production Next server + gateway + Chromium
pnpm desktop:e2e:cloud    # Cloud capabilities and Hydite login surface
pnpm desktop:e2e:electron # real Electron shell under Xvfb (Linux CI)
```

The Chromium E2E starts `next start` with `OPENLINK_STATIC_UI=1`, starts the
real gateway, and drives the Vite renderer in headless Chromium. The Electron
E2E launches the actual Electron 44 shell, verifies the preload bridge, the
loopback gateway origin, the root app-entry redirect (login/onboarding), and the
connection panel. On macOS or Windows, run
`npm --prefix desktop run test:electron` with a display instead of the Xvfb
wrapper.

A real server verification is also available:

```bash
OPENLINK_E2E_SERVICE_KEY=... node desktop/test/e2e-real-local.mjs
```

It signs in to a running local self-hosted server with a real magic-link token,
then verifies real workspace/chat data, the chat stream against Agent Host, and
settings persistence through the desktop action bridge.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `OPENLINK_DESKTOP_URL` | Default self-hosted profile URL |
| `OPENLINK_DESKTOP_PROFILE_NAME` | Display name for the default profile |
| `OPENLINK_DESKTOP_CLOUD_URL` | Default Cloud profile URL |
| `OPENLINK_DESKTOP_UPSTREAM` | Vite dev proxy target |
| `OPENLINK_DESKTOP_RENDERER_URL` | Load a Vite dev server instead of the gateway |
| `OPENLINK_DESKTOP_AUTH_PORT` | Hydite loopback callback port (default 43127) |
| `OPENLINK_DESKTOP_USER_DATA` | Isolated profile/session data directory |
| `OPENLINK_ELECTRON_BINARY` | Explicit Electron binary for the E2E harness |

## Security

- Renderer: context isolation, sandbox, no Node integration.
- Preload: explicit IPC channels only.
- Gateway: loopback bind, `Host` and `Origin` validation, cookie
  sanitization, no credential storage in the renderer.
- Auth: the Hydite code exchange happens in the renderer; the main process only
  captures the one-shot loopback code. Refresh tokens stay in the SDK's memory
  store and are revoked after the exchange.

## Local-first is a separate product

A true single-machine OpenLink (SQLite/PGlite storage, local auth, lightweight
sandbox) is a different product shape. It must not be implemented as a hidden
mode of this client or of the self-hosted server; see ADR-0031.
