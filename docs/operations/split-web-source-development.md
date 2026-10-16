# Run Web/BFF from Linux while keeping the local runtime in its current checkout

OpenLink's Web and BFF are the Next.js application. The BFF routes run in the
Next.js server process; the browser does not call Agent Host or Knowledge
Service with their internal credentials.

The full Local backend is **not one Docker Compose stack**. ZOKERBASE and Zero
run in Docker Compose. Agent Host, Browser Host and Knowledge Service are
supervised native Node processes. Project workloads use the configured
Container or VM runtime. This setup keeps those existing processes, images and
state in the backend checkout, and moves only the Next.js source/dependencies
and `.next` output to a Linux filesystem checkout.

## Prepare the Web checkout

Create or update the matching OpenLink checkout at
`/home/haokir-yike/openlink`, on the same source revision as the backend
checkout. Install its dependencies there so Next.js does not read its source,
dependency links or build output from the mounted Windows volume:

```bash
cd /home/haokir-yike/openlink
pnpm install --frozen-lockfile
```

## Start the split development stack

From the existing backend/runtime checkout, set the Web root and start the
normal Local supervisor:

```bash
cd /mnt/iscsi/hydb.post/Windows/openlink
OPENLINK_WEB_ROOT=/home/haokir-yike/openlink pnpm dev:split
```

The supervisor continues to start the local services and Docker stacks from
the backend checkout. It starts `pnpm dev:web` from `/home/haokir-yike/openlink`
and passes the active runtime mode, ZOKERBASE endpoint and publishable key,
Agent Host URL and bearer token, Knowledge Service URL and bearer token, and
browser-gateway configuration to the Next server process. It checks that the
Web checkout has its dependencies and the same Next.js version before
starting the stack. `pnpm dev:local` without `OPENLINK_WEB_ROOT` keeps its
existing behavior.

The browser receives only the ZOKERBASE publishable key and its own user
session. Agent Host and Knowledge Service tokens remain server-side in the
Next.js process. In Local mode, browser-side Supabase requests use the same
origin `/api/openlink-zokerbase` rewrite; server-side BFF requests use the
configured service URLs. The backend and Web process are on the same host by
default, so the existing loopback service URLs remain valid.

## If the backend is on another host

The Web/BFF routes already accept externally configured service URLs and
server-only API tokens. Run only `pnpm dev:web` in the Web checkout and provide
the corresponding runtime configuration to that Next.js process:

```text
OPENLINK_RUNTIME_MODE=local
OPENLINK_LOCAL_ZOKERBASE_URL=https://<private-zokerbase-origin>
OPENLINK_LOCAL_ZOKERBASE_PUBLISHABLE_KEY=<publishable-key>
OPENLINK_AGENT_HOST_URL=https://<private-agent-gateway-origin>
OPENLINK_AGENT_API_TOKEN=<same-token-configured-on-agent-host>
OPENLINK_KNOWLEDGE_SERVICE_URL=https://<private-knowledge-origin>
OPENLINK_KNOWLEDGE_INTERNAL_TOKEN=<same-token-configured-on-knowledge-service>
```

Only include Knowledge Service settings when that service is enabled. Keep
Agent Host and Knowledge Service behind a VPN/private network or an
authenticated TLS gateway and restrict inbound access to the Web/BFF host.
Their default service bindings are loopback; the service operator must
explicitly configure a private listener and firewall rule for a remote Web
host. The `pnpm dev:split` supervisor is the same-host profile and does not
change those bindings.

The sealed self-hosted production runtime intentionally remains single-node
and sets service URLs to loopback. Do not use this development profile as a
claim that the production installer supports a multi-host topology.
