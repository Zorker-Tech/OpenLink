# OpenLink Browser Host

Browser Host is the privileged browser runtime shared by OpenLink Web, Desktop,
and Pi. It is a standalone Node service and must not be imported into the
Next.js process.

It provides two complete surfaces:

- `native-preview` forwards an approved loopback project server over HTTP and
  WebSocket, injects the Inspector Bridge, and lets the web client render and
  edit the real DOM in a sandboxed iframe.
- `chromium-stream` launches a persistent isolated Chromium context, streams
  CDP screencast frames, and accepts viewport-correct mouse, drag, wheel,
  keyboard, IME, navigation, dialog, download, screenshot, and DOM actions.

The same Browser Protocol is consumed by the Web Workbench and bundled Pi
extension, and is the contract boundary for the desktop VS Code Integrated
Browser adapter when the desktop host is wired.

## Security boundary

- The server binds to loopback by default.
- Service APIs require `OPENLINK_BROWSER_API_TOKEN`.
- Browser and iframe clients receive short-lived, session-bound HMAC
  capabilities rather than the service token.
- Preview upstreams must be loopback HTTP(S) endpoints. Remote ports reach
  Browser Host only through strict-host-key-checked SSH local forwarding.
- Chromium rejects non-HTTP schemes, applies domain policy, resolves DNS before
  requests, and denies loopback/private networks unless explicitly enabled.
- Browser profiles, downloads, and events are isolated per user/session.
- Human input preempts the Agent control lease; the Agent cannot preempt a live
  human lease.

## Configuration

Required:

```bash
OPENLINK_BROWSER_API_TOKEN="$(openssl rand -base64 48)"
OPENLINK_BROWSER_TOKEN_SECRET="$(openssl rand -base64 48)"
OPENLINK_BROWSER_ALLOWED_ORIGINS="http://localhost:3000"
```

Runtime:

```bash
OPENLINK_BROWSER_HOST=127.0.0.1
OPENLINK_BROWSER_PORT=43120
OPENLINK_BROWSER_PUBLIC_URL=http://127.0.0.1:43120
OPENLINK_BROWSER_STORAGE_ROOT=.browser-data
OPENLINK_CHROME_EXECUTABLE=/path/to/chromium
OPENLINK_BROWSER_MAX_SESSIONS=32
OPENLINK_BROWSER_SESSION_TTL_MS=3600000
OPENLINK_BROWSER_CONTROL_LEASE_TTL_MS=15000
```

`OPENLINK_BROWSER_PUBLIC_URL` is the URL visible to the Web UI. In desktop
development it can be loopback. In a web deployment it is an authenticated
gateway route which forwards to this loopback service; no per-preview domain is
required.

## SSH preview

The session creation API accepts an `sshForward` configuration containing the
approved target, remote loopback port, identity file, and known-hosts file.
Browser Host executes `ssh` without a shell using:

```text
BatchMode=yes
ExitOnForwardFailure=yes
StrictHostKeyChecking=yes
ServerAliveInterval=15
```

The resulting local listener binds to `127.0.0.1`. Remote project, Chrome CDP,
VNC, and OpenSandbox ports are never exposed publicly.

## Managed preview base paths

An iframe sandbox isolates content but does not rewrite application URLs.
Relative assets work with `strip-session-prefix`. Applications that generate
root-absolute asset or HMR URLs must be launched by their framework adapter with
the Browser Host session base path and use `preserve-session-prefix`.

This is an explicit launch contract. Browser Host does not attempt unsafe,
incomplete rewriting of arbitrary JavaScript, workers, or WebSocket URLs. Sites
that cannot honor a base path use `chromium-stream`.

## Run and verify

```bash
cd services/browser-host
npm install
npm test
npm start
```

Health check:

```bash
curl http://127.0.0.1:43120/healthz
```

For local OpenLink development, the root supervisor generates in-memory
capabilities, detects an installed Chromium-family browser, starts Browser Host,
waits for health, and then starts Next.js:

```bash
pnpm dev:browser
```

The Next.js BFF uses these server-only variables:

```bash
OPENLINK_BROWSER_HOST_URL=http://127.0.0.1:43120
OPENLINK_BROWSER_API_TOKEN=<same service token>
OPENLINK_PREVIEW_TARGET_URL=http://127.0.0.1:3001
OPENLINK_PREVIEW_PATH_MODE=strip-session-prefix
```

For remote Web execution, Agent Host provisions Browser Host/Chromium inside or
alongside OpenSandbox and supplies the SSH-owned public gateway route.
