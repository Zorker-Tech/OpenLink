# OpenLink Agent Host

This is the OpenLink-owned boundary for running Pi in an isolated execution
environment. It is an independent Node service, not a Next.js route and not a
root workspace package.

The host exposes one backend-neutral lifecycle:

```text
request → validate policy/storage → provision backend → launch agent worker
        → relay JSONL events → persist session/artifacts → cleanup
```

Backends:

- `local-opensandbox.ts`: web execution through OpenSandbox and Pi's Node.js SDK.
- `local-sandbox-runtime-sdk.ts`: desktop process isolation around the same
  Node.js SDK worker.
- `remote-opensandbox.ts`: remote OpenSandbox execution through Pi CLI's direct
  `rpc-entry.js` transport and the RPC Worker gateway.
- `ssh.ts`: strict-host-key bootstrap execution and loopback port forwarding.
- `project-vm.ts`: project-scoped Podman machine lifecycle. A machine is
  durable per project; each chat session still creates and cleans up its own
  OpenSandbox workload.

Browser integration:

- `browser-client.ts` provisions isolated Browser Host sessions and performs
  actions with a session-scoped control capability.
- `services/agent-browser-extension/openlink-browser.ts` is copied into each
  immutable worker image and registers Pi browser tools for open,
  read, navigate, click, type, hover, drag, keyboard, scroll, screenshot, and
  dialog behavior.
- `AgentLaunchSpec.browser` adds the extension and scoped Browser Host
  environment to Pi RPC without exposing the Browser Host service token.
- `BrowserEnabledAgentOrchestrator` provisions Browser Host and Agent Host as
  one lifecycle, binds the agent-only capability into Pi, and always cleans up
  both runtimes together.
- `browser-gateway.ts` publishes session-scoped preview and WebSocket URLs for
  remote Web UIs. Project VM loopback URLs and Browser Host service tokens are
  never returned to the browser; an HTTPS reverse proxy must forward the
  gateway paths in remote deployments.

No backend performs work as an import side effect. Web startup explicitly starts
OpenSandbox; remote setup executes a checksum-verified bootstrap plan and opens
an SSH tunnel; desktop startup injects sandbox-runtime's `SandboxManager`.

Runnable profiles:

- `npm start`: web OpenSandbox + Pi Node SDK transport on port 43121.
- `npm run start:desktop`: desktop sandbox-runtime + Pi Node SDK transport on
  port 43123. `SandboxManager` is process-global, so this standalone profile
  deliberately permits one active session; the desktop shell starts a separate
  supervisor process for each concurrently active session.
- `npm run start:remote`: strict-host-key SSH bootstrap + one loopback tunnel +
  remote OpenSandbox + Pi CLI RPC transport on port 43124.

`pnpm dev:local` starts the web and desktop profiles together for local
integration testing. The Next.js application only receives the web profile's
server-side URL and token.

## Project VM mode

Project VM mode is explicit and never reports a fake ready state. OpenLink's
image-production pipeline publishes a bootable, local Project VM disk. The
runtime only copies that disk when it creates a Project VM; it does not pull a
machine OS, build an OCI image, or run `bootc switch` during service startup.
The startup supervisor builds the Podman CLI from `services/linux` and uses it
to create the local Linux Project VM; no system Podman installation is
required. Start the web Agent Host with:

```bash
OPENLINK_PROJECT_VM_MODE=podman-machine \
OPENLINK_PROJECT_VM_STATE_ROOT=/var/lib/openlink/project-vms \
npm start
```

The first session for a project runs `podman machine init/start` from the
published local disk, prepares a project workspace, enables the guest Podman
socket, and makes the complete Git/Node/npm/pnpm/Python/build toolchain
available to Session images. Image production is explicit and separate:
`OPENLINK_BUILD_ARTIFACTS=1` runs the build pipeline and writes the OCI source
and bootable disk under `.openlink-runtime/project-vm-base/`. If the engine,
VM, socket, images, or service bootstrap fails, the request returns a retryable
provisioning error and no shared-host runtime is used.

## Remote release

Build a pinned, checksummed release before starting the remote profile:

```bash
node scripts/build-agent-remote-bundle.mjs \
  --release-id 2026-08-06.1 \
  --remote-root /home/openlink/.openlink-agent \
  --platform linux/amd64
```

The SSH user must own the chosen remote root and have passwordless sudo for
QEMU/KVM and guest provisioning. The release contains the Podman engine built
from `services/linux`; OpenSandbox, Browser Host, Pi workers, and Session
sandboxes run inside the selected Project VM through direct Podman commands.
Docker Compose is not used by the remote Project=VM profile.

## Local development

```bash
cd services/agent-host
npm run check
npm test
```
