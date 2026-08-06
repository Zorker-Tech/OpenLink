# OpenLink services

OpenLink services are independently deployable runtimes. They keep their own
package manager, lockfile, Node runtime, build pipeline, and release cadence;
they are not part of the Next.js application workspace.

## Service layout

```text
services/
├── agent-host/          # OpenLink-owned orchestration contracts and backends
├── agent-worker/        # Pi Node.js SDK worker used by web and desktop
├── agent-rpc-worker/    # Pi CLI RPC gateway used by remote OpenSandbox
├── browser-host/        # browser sessions, preview proxy, Chromium/CDP runtime
├── opensandbox/         # remote sandbox platform (submodule)
├── pi/                  # independent agent runtime (submodule)
└── sandbox-runtime/     # desktop OS sandbox (submodule)
```

The three upstream repositories are deliberately not root workspace packages.
Each keeps its own build system, lockfile, runtime requirements, and release
cadence. `services/agent-host` and `services/browser-host` are the OpenLink-owned
integration boundaries.
Its current implementation validates policies, storage paths, Pi RPC frames,
and remote bootstrap plans while keeping privileged adapters dependency
injected.

## Pi agent

`services/pi` is a pinned upstream submodule for
[`earendil-works/pi`](https://github.com/earendil-works/pi). It is intentionally
kept independent from the OpenLink application and its Supabase/Vercel AI
service code.

The upstream repository is a Node monorepo with its own npm workspaces and
requires Node `>=22.19.0`. Run Pi-specific installation and build commands
from `services/pi`, never from the OpenLink root:

```bash
cd services/pi
npm install --ignore-scripts
npm run build
```

The current checkout is pinned by the parent repository's submodule entry. The
OpenLink adapter and process-supervision contracts live in `services/agent-host`
rather than modifying the upstream source or importing Pi into the Next.js
bundle.

Pi's upstream runtime exposes local shell and filesystem tools and does not
provide a built-in permission boundary. The service wrapper must add an explicit
workspace, environment, network, timeout, and process boundary before accepting
user input.

## OpenSandbox

`services/opensandbox` pins
[`opensandbox-group/OpenSandbox`](https://github.com/opensandbox-group/OpenSandbox)
for remote execution. Its server owns sandbox lifecycle and typically uses a
Docker runtime; the target host must provide Docker/Kubernetes prerequisites.
OpenLink should bind the control plane to target loopback and reach it through an
authenticated SSH tunnel. Do not expose a Docker-socket-backed server directly
to the public network.

## Anthropic sandbox-runtime

`services/sandbox-runtime` pins
[`anthropic-experimental/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime)
for desktop execution. Its Node library wraps the Pi Node.js SDK worker with OS
filesystem and network restrictions (`sandbox-exec` on macOS, bubblewrap on
Linux, and the Windows sandbox helper where supported).

None of the upstream repositories are installed or executed by the Next.js app.
Build and run each service from its own directory with the runtime and package
manager required by that repository.

## Browser Host

`services/browser-host` owns native project preview forwarding, the Inspector
Bridge, isolated Chromium profiles, CDP screencasting, human/agent control
leases, scoped capabilities, and SSH local port forwarding. The web application
talks to it through authenticated BFF and WebSocket routes; Pi uses the bundled
extension under `services/agent-host/pi-extensions`.
