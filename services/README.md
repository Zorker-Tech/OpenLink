# OpenLink services

OpenLink services are subordinate runtimes of the OpenLink product. They keep
their own language-specific runtimes, dependency metadata, and build boundaries
so a service cannot accidentally leak dependencies into the Next.js bundle, but
their installation, build, startup, health supervision, and shutdown are owned
by the OpenLink root lifecycle.

Run `pnpm dev` for development or `pnpm start` for production from the
repository root. The supervisor builds the Podman toolchain from
`services/linux`, verifies the pinned Civilization source, syncs Pi, installs
stale or missing service dependencies, builds the service artifacts and Project
VM images, and starts the Browser Host, Web Agent Host, Desktop Agent Host, and
web application. Users do not enter individual service directories to install
or start product services.

## Service layout

```text
services/
├── agent-host/          # OpenLink-owned orchestration contracts and backends
├── agent-worker/        # Pi Node.js SDK worker used by web and desktop
├── agent-rpc-worker/    # Pi CLI RPC gateway used by remote OpenSandbox
├── browser-host/        # browser sessions, preview proxy, Chromium/CDP runtime
├── civilization/        # Civilization 1.0.0 upstream service, subtree-imported
├── opensandbox/         # remote sandbox platform (subtree-imported source)
├── pi/                  # independent agent runtime (subtree-imported source)
├── sandbox-runtime/     # desktop OS sandbox (subtree-imported source)
├── code-server/         # project-scoped VS Code web runtime source
├── zero/                # Zero vector runtime source for the Knowledge system
└── knowledge-service/   # OpenLink-owned metadata/vector gateway
```

The upstream repositories are deliberately not root workspace packages. Each
keeps its own build system, lockfile, runtime requirements, and release cadence,
while the root supervisor is the only supported product lifecycle entry point.
`services/agent-host` and `services/browser-host` are the OpenLink-owned
integration boundaries.
Its current implementation validates policies, storage paths, Pi RPC frames,
and remote bootstrap plans while keeping privileged adapters dependency
injected.

Civilization stays as a separate upstream service at `services/civilization`.
Agent Host starts its Stage74 Orion memory service through the small
OpenLink-owned `services/agent-host/civilization-host.py` launcher and exposes
project-and-mode-scoped memory tools. The root lifecycle verifies the pinned
`v1.0.0` source before building Agent Host, and self-hosted releases copy the
complete vendored project.

## Zero

`services/zero` is the vendored vector runtime source imported into this
monorepo with `git subtree`. The OpenLink-facing runtime, images, containers,
environment variables, health response, and Knowledge Service protocol are
branded Zero. The vendored source retains its upstream implementation and
wire-compatible REST v2 handlers; it is not part of the root pnpm workspace and
is not compiled into the Next.js application. The exact upstream source
revision is recorded in `services/source-revisions.json`.

The Knowledge system builds and supervises Zero Standalone locally through the
root lifecycle. `services/knowledge-service` is the only runtime boundary for
knowledge operations: it authenticates an internal bearer token, checks
workspace membership through ZOKERBASE service-role access, stores documents,
chunks, and jobs in PostgreSQL, and uses the Zero vector protocol for the
projection. Project VMs and browser clients never receive Zero credentials or
connect directly to the Zero vector endpoint.

The local stack uses only product-owned `zokerbase/zero`,
`zokerbase/zero-etcd`, and `zokerbase/zero-minio` images. Build and archive them
once with `pnpm runtime:zero:images`; ordinary startup fails with an actionable
message when the local images are absent instead of pulling an upstream image.
Distributed deployment is a separate queued workflow that creates a new
cluster, migrates and validates vectors, then cuts the API over.

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

## Agent Desktop

`services/agent-desktop` vendors
[`vercel-labs/agent-desktop`](https://github.com/vercel-labs/agent-desktop) with
its full upstream history. It is the Apache-2.0 Linux CLI that exposes a
desktop application's AT-SPI accessibility tree as JSON and performs element
actions without pixel matching.

The T1/T2 Project VM bases install the pinned `1.0.2` x86_64 release at
`/usr/local/bin/agent-desktop` with its clipboard helper. The real binary runs
on the Project VM host because its PID namespace owns the desktop processes.
A constrained Unix-socket bridge is exposed to session containers, which
receive only a small CLI shim plus the socket. Agent Host writes the
`agent-desktop` skill into the Pi/Codex skill roots for every T1/T2 session.

## Browser Host

`services/browser-host` owns native project preview forwarding, the Inspector
Bridge, isolated Chromium profiles, CDP screencasting, human/agent control
leases, scoped capabilities, and SSH local port forwarding. The web application
talks to it through authenticated BFF and WebSocket routes; Pi uses the bundled
extension under `services/agent-host/pi-extensions`.
