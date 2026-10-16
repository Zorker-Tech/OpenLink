# ADR-0025: Run the Local Web/BFF from a Separate Source Checkout

## Status

Accepted

## Context

The OpenLink Web/BFF is a Next.js server, while local ZOKERBASE, Zero,
Agent Host, Browser Host, Knowledge Service and Project runtimes have separate
process and data lifecycles. A checkout on a mounted Windows/APFS volume can
make Next.js dependency access, compilation and hot reload slow. Developers
need to keep the backend checkout and its existing runtime/image state in
place while running Web/BFF source from a native Linux filesystem.

The Web/BFF already reaches ZOKERBASE over Supabase-compatible HTTP APIs,
Agent Host over an authenticated internal HTTP API, and Knowledge Service over
an authenticated internal HTTP API. Those credentials are available to the
server process and are not browser credentials.

## Decision

The development supervisor accepts an optional `OPENLINK_WEB_ROOT`. When it
is set, the supervisor starts `dev:web` with that checkout as its working
directory and passes the same server-side runtime configuration it would pass
to the in-checkout Web process. `pnpm dev:split` requires this override and
validates that the selected checkout has installed dependencies and uses the
same Next.js version and `dev:web` command.

The default local topology remains one host: the Next.js Web/BFF runs from the
Linux checkout, while the existing checkout continues to own the local runtime,
service processes, Docker Compose stacks, Project runtime artifacts and state.
The Web/BFF communicates through the existing APIs and keys:

- ZOKERBASE uses its publishable key and the user's authenticated session/RLS.
- Agent Host uses `OPENLINK_AGENT_HOST_URL` and the server-only
  `OPENLINK_AGENT_API_TOKEN` bearer credential.
- Knowledge Service uses `OPENLINK_KNOWLEDGE_SERVICE_URL` and the server-only
  `OPENLINK_KNOWLEDGE_INTERNAL_TOKEN` bearer credential.
- Browser gateway URLs are public routing configuration; scoped session
  capabilities authorize browser traffic. Browser Host service credentials
  are not sent to the browser.

The optional source-root override is development-only. Sealed self-hosted
production remains the supported single-node topology described by
ADR-0021 and ADR-0020. This decision does not introduce multi-node production,
load balancing, or a new public service endpoint.

## Consequences

### Positive

- Next.js reads, writes `.next`, watches source and resolves its dependencies
  from the native Linux checkout.
- Existing Docker images, backend processes, service credentials and mutable
  runtime state are not copied or moved by this option.
- The supervisor remains the owner of startup and shutdown, and the Web/BFF
  receives runtime URLs and credentials from the same source as the services.

### Negative

- The Web checkout must stay on a compatible source revision with the backend
  checkout; mismatched API routes and service contracts can fail at runtime.
- The two checkouts need separate dependency installations and consume extra
  disk space.
- This is a same-host development profile. A production deployment on separate
  hosts needs a separately defined service topology, TLS/network policy,
  secret distribution and health/upgrade contract.

## Security and rollback

Internal service tokens remain in the Next server process environment and must
never use `NEXT_PUBLIC_` names or be returned by a route. ZOKERBASE publishable
keys are public by design and data authorization remains enforced by the user
session and RLS. Services keep their default loopback binding for this
same-host profile. For a separately networked development backend, expose only
authenticated HTTPS/private-network gateways and restrict their firewall
origins; never publish raw service ports to the Internet.

Rollback is immediate: unset `OPENLINK_WEB_ROOT` and run `pnpm dev:local` to
start Next.js from the backend checkout as before.
