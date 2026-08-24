# ADR-0018: Serve Local Project Supabase Studio through a scoped BFF virtual host

## Status

Accepted

## Context

The OpenLink data panel is the product's default Project backend surface. Local
users may also need the complete upstream Supabase Studio while development is
in progress. Studio is valuable for advanced database work, but self-hosted
Studio is protected by HTTP Basic authentication and is rooted at `/`; it does
not support a safe per-project base path.

An iframe pointed directly at a Project VM gateway would expose a VM control
port and require the browser to receive the Studio password. A general purpose
iframe proxy at an OpenLink application subpath would break Studio's
root-relative routes and static assets. Both options violate the Project VM
secret and network boundaries.

## Decision

In Local mode only, OpenLink serves Studio through a dedicated
`studio.localhost` virtual host in the existing Next.js BFF process:

```text
OpenLink data panel (localhost)
  -> short-lived project/session-scoped BFF capability cookie
  -> Studio iframe (studio.localhost, same Next BFF process)
  -> internal Agent Host bearer
  -> Project VM runtime controller
  -> VM-loopback Supabase gateway + Studio
```

The capability is HMAC-signed, expires after 15 minutes, contains only the
user, chat session and project scope, and is not a Supabase credential. The
Studio virtual host accepts no ZOKERBASE session cookie. It forwards only a
small allow-list of HTTP request and response headers.

The Project VM controller performs the upstream request itself and injects the
per-project Studio Basic credential inside the guest. The credential, database
password, service-role keys and Project VM ports never appear in the browser,
Next response, Agent Host response or logs. The virtual host is disabled in
Cloud mode.

OpenLink's native data panel remains the default Local and Cloud experience.
Cloud will receive product-owned management capabilities rather than exposing
an upstream dashboard iframe.

## Consequences

### Positive

- Local Studio works with its required root-relative URLs without direct VM
  exposure.
- Advanced Local users retain upstream SQL, schema and policy workflows.
- The Cloud control-plane and tenant boundary do not inherit Studio's
  self-hosted administrative surface.

### Negative

- The Local proxy is intentionally HTTP request/response based; upgrades that
  require WebSocket-only Studio features need a separately reviewed streaming
  transport.
- `studio.localhost` requires opening the Local app through `localhost`, not
  `127.0.0.1`.
- The proxy needs integration coverage against each pinned Studio release.

## Alternatives considered

### Direct iframe to the Project VM gateway

Rejected because it exposes a VM port and requires dashboard credentials in
the browser.

### Mount Studio below an ordinary BFF route

Rejected because self-hosted Studio serves at `/` and its root-relative assets
and API calls break under a base path.

### Make upstream Studio the primary product panel

Rejected because its lifecycle and self-hosted constraints are not the
OpenLink Local/Cloud product contract.

