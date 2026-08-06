# ADR-0004: Separate Browser Surfaces Behind One Runtime Protocol

## Status

Accepted

## Context

OpenLink must let users and the Pi agent operate the same browser session from
both the web and desktop products. Project previews need native DOM interaction,
component inspection, hot reload, forms, keyboard input, and drag interactions.
Arbitrary external sites also need complete Chromium behavior even when they
cannot be embedded because of CSP, `X-Frame-Options`, or cross-origin policy.

The VS Code Integrated Browser is implemented with Electron `WebContentsView`
and is unavailable in the web workbench. OpenLink already separates desktop
execution through sandbox-runtime from remote execution through OpenSandbox and
SSH. Remote services bind to loopback and are reached only through an
authenticated SSH transport.

An iframe `sandbox` attribute isolates a document but does not transport a
remote TCP port to a web browser. The web client therefore still needs an
authenticated HTTP/WebSocket bridge terminating at the Browser Host. A custom
domain per preview is not required; OpenLink-managed projects must instead run
with a session base path so HTTP assets and HMR WebSockets stay inside the
session-scoped route.

## Decision

Create a backend-neutral Browser Protocol and a dedicated Browser Host runtime.

The Browser Host supports two surfaces:

1. `native-preview` proxies an OpenLink-managed project server through a signed,
   session-scoped HTTP/WebSocket path. It injects the OpenLink Inspector Bridge
   into HTML responses. The web UI renders that URL in a sandboxed iframe and
   communicates with the bridge using a versioned `postMessage` protocol.
2. `chromium-stream` owns a complete isolated Chromium profile. It exposes page
   state, CDP accessibility/DOM observations, screencast frames, and input over
   an authenticated WebSocket. Agent and human commands are serialized through
   a control lease.

The desktop adapter implements the same protocol using VS Code Integrated
Browser and its CDP session. Remote desktop workspaces continue to use SSH
forwarding; the Browser Runtime is never imported into the Next.js request
process.

Remote preview, CDP, and streaming ports bind to target loopback. SSH local
forwarding terminates at Browser Host. Web clients connect only to OpenLink's
authenticated Browser Gateway paths.

## Consequences

### Positive

- Project previews remain native DOM pages instead of image-only viewers.
- Arbitrary sites retain full Chromium behavior and remain controllable.
- Pi sees one tool contract on web and desktop.
- No remote project, CDP, VNC, or browser port is publicly exposed.
- Per-preview custom domains are unnecessary.

### Negative

- Managed dev servers must honor a session base path for absolute asset and HMR
  URLs. Framework launch adapters are responsible for that configuration.
- Chromium streaming consumes more CPU and bandwidth than iframe preview.
- Native preview and Chromium streaming have different rendering paths and
  require contract-level conformance tests.

### Neutral

- A shared gateway origin can host many sessions because the session id remains
  in every managed preview path.
- Sites that cannot run under a base path use `chromium-stream` rather than an
  unreliable HTML rewriting fallback.

## Alternatives Considered

### Screenshot-only browser

Rejected. It cannot provide native editing, reliable component selection, text
input, or accessible DOM observations.

### iframe arbitrary external websites

Rejected. Embedding and inspection are blocked by browser security controls and
cannot be made reliable by OpenLink.

### Rewrite every remote HTML, CSS, and JavaScript URL

Rejected. Dynamic imports, workers, WebSockets, CSP, redirects, and framework
runtime URL construction make universal rewriting incomplete and unsafe.

### Publicly expose every remote project port

Rejected. SSH already provides the approved transport boundary, and public
ports would expand the attack surface and bypass OpenLink authorization.

## References

- `docs/architecture/ADR-0003-agent-execution-boundaries.md`
- `services/agent-host`
- `services/opensandbox/examples/chrome`
- `/Volumes/Net/vscode/src/vs/platform/browserView`

