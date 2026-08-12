# ADR-0009: Public gateway for Project Browser sessions

## Status

Accepted

## Context

Project VMs and their Browser Hosts are intentionally reachable only through
Agent Host loopback forwarding. The `eventsUrl` and `previewUrl` returned by a
Browser Host therefore contain `127.0.0.1` and are valid only from Agent Host.
Returning those URLs to a remote Web UI makes realtime Chromium control,
native preview, inspector bridge requests, and preview HMR sockets connect to
the user's own computer instead of the Project VM.

## Decision

Agent Host exposes a session-scoped Browser Gateway. On browser-session
creation it creates a cryptographically random opaque capability and returns
URLs under:

```text
/v1/browser/gateway/sessions/<browser-session-id>/events
/v1/browser/gateway/sessions/<browser-session-id>/preview/...
```

The gateway validates the browser origin and capability, then proxies the
human WebSocket and native-preview HTTP/WebSocket traffic to the internal
Browser Host URL. Browser Host service tokens and its signed capability tokens
remain inside Agent Host. The gateway token is memory-only and expires with the
Browser session; deleting a session removes its binding.

`OPENLINK_BROWSER_GATEWAY_PUBLIC_URL` must be the externally reachable origin
of the authenticated reverse proxy in a remote deployment. The Agent Host
still binds its service API to loopback unless an operator explicitly places it
behind that proxy. `OPENLINK_BROWSER_GATEWAY_ALLOWED_ORIGINS` restricts browser
origins, and the upstream connection uses the Browser Host's configured parent
origin so the Project VM does not need to accept arbitrary public origins.

## Consequences

- Remote Web UI can use native DOM preview and full Chromium interaction
  without public VM, CDP, Browser Host, or SSH ports.
- The gateway is intentionally process-local. Agent Host restart invalidates
  browser sessions and the UI recreates them; durable Chromium profiles remain
  in the Project VM.
- A reverse proxy must support HTTP upgrade for `/v1/browser/gateway/*` and
  preserve `Upgrade`/`Connection` headers for realtime mode.
- Preview HTML is streamed and bounded; the injected inspector bridge URL is
  rewritten to the session gateway path, while upstream preview capability
  tokens are never sent to the browser.

