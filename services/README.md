# OpenLink services

OpenLink services are subordinate runtimes of the OpenLink product. They keep
their own package manager, lockfile, Node runtime, and build boundary so that a
service cannot accidentally leak dependencies into the Next.js bundle, but
their installation, build, startup, health supervision, and shutdown are owned
by the OpenLink root lifecycle.

Run `pnpm dev` for development or `pnpm start` for production from the
repository root. The supervisor builds the Podman toolchain from
`services/linux`, syncs Pi, installs stale or missing service dependencies,
builds the service artifacts and Project VM images, and starts the Browser
Host, Web Agent Host, Desktop Agent Host, and web application. Users do not
enter individual service directories to install or start product services.

## Service layout

```text
services/
├── agent-host/          # OpenLink-owned orchestration contracts and backends
├── agent-worker/        # Pi Node.js SDK worker used by web and desktop
├── agent-rpc-worker/    # Pi CLI RPC gateway used by remote OpenSandbox
├── browser-host/        # browser sessions, preview proxy, Chromium/CDP runtime
├── opensandbox/         # remote sandbox platform (subtree-imported source)
├── pi/                  # independent agent runtime (subtree-imported source)
├── sandbox-runtime/     # desktop OS sandbox (subtree-imported source)
└── code-server/         # project-scoped VS Code web runtime source
```

The upstream repositories are deliberately not root workspace packages. Each
keeps its own build system, lockfile, runtime requirements, and release cadence,
while the root supervisor is the only supported product lifecycle entry point.
`services/agent-host` and `services/browser-host` are the OpenLink-owned
integration boundaries.
Its current implementation validates policies, storage paths, Pi RPC frames,
and remote bootstrap plans while keeping privileged adapters dependency
injected.

## Pi agent

`services/pi` is upstream source imported into the root monorepo for
[`earendil-works/pi`](https://github.com/earendil-works/pi). It is intentionally
kept independent from the OpenLink application and its Supabase/Vercel AI
service code.

The upstream repository is a Node monorepo with its own npm workspaces and
requires Node `>=22.19.0`. The root lifecycle installs and packages it through
`scripts/sync-pi-runtime.mjs`; Pi remains isolated from the Next.js dependency
graph even though its lifecycle is automatic.

The imported source revision is recorded in `services/source-revisions.json`.
The OpenLink adapter and process-supervision contracts live in
`services/agent-host` rather than importing Pi into the Next.js bundle.

Pi's upstream runtime exposes local shell and filesystem tools and does not
provide a built-in permission boundary. The service wrapper must add an explicit
workspace, environment, network, timeout, and process boundary before accepting
user input.

## OpenSandbox

`services/opensandbox` vendors
[`opensandbox-group/OpenSandbox`](https://github.com/opensandbox-group/OpenSandbox)
for web and remote execution. Each Project VM runs its own OpenSandbox control
plane against the Podman compatibility socket supplied by the Podman engine
built from `services/linux`; each Session is a separate sandbox in that VM.
Remote Project VMs are reached through authenticated SSH transport and the
control plane is never exposed directly to the public network.

## Anthropic sandbox-runtime

`services/sandbox-runtime` vendors
[`anthropic-experimental/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime)
for desktop execution. Its Node library wraps the Pi Node.js SDK worker with OS
filesystem and network restrictions (`sandbox-exec` on macOS, bubblewrap on
Linux, and the Windows sandbox helper where supported).

The Next.js process does not import or execute upstream service code directly.
The root supervisor owns their processes and communicates over authenticated
service contracts, preserving both the dependency boundary and a single
OpenLink lifecycle.

## Browser Host

`services/browser-host` owns native project preview forwarding, the Inspector
Bridge, isolated Chromium profiles, CDP screencasting, human/agent control
leases, scoped capabilities, and SSH local port forwarding. The web application
talks to it through authenticated BFF and WebSocket routes; Pi uses the bundled
extension under `services/agent-host/pi-extensions`.
