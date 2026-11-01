# Project computer architectures

OpenLink has one durable Project VM per project. The desktop and session
topology are selected explicitly at startup. This directory is the index for
the supported runtime architectures; the binding decision is
[ADR-0029](../ADR-0029-project-computer-t1-e1-modes.md).

## Modes

| Mode | Status | Project VM | Desktop | Startup |
| --- | --- | --- | --- | --- |
| [`t1`](./t1/README.md) | Default | Ubuntu Project VM (pinned userspace + LTS generic kernel) + rootful Podman | One native project desktop shared by all chats | `pnpm dev:local`, `-t1` |
| [`e1`](./e1/README.md) | Optional, explicit | Podman machine OS + rootful Podman | Per-chat container desktop (Xvfb + GNOME/Xfce) | `-e1` |
| experimental ISO | Not a product support commitment | Session container + nested QEMU/KVM | Full Ubuntu Desktop guest per chat | Explicit legacy configuration only |

## Selection

`scripts/openlink.mjs` owns the selection:

```bash
pnpm dev:local          # T1 (default)
pnpm dev:local:e1       # E1
node scripts/openlink.mjs --mode development --profile local --arch e1
node scripts/openlink.mjs --mode production -t1
```

The resolved mode is exported as `OPENLINK_ARCHITECTURE` (`t1` or `e1`). The
Agent Host receives the corresponding `OPENLINK_PROJECT_VM_DRIVER` and desktop
scope; the Web/BFF never needs a mode-specific code path.

## Shared invariants

1. One project owns one durable Project VM. A chat is a session inside it.
2. Project data (`/workspace`), project services and the project desktop are
   project-scoped; chat sessions own only their session storage.
3. The Project VM is the host isolation boundary. Session workloads are
   additionally isolated by OpenSandbox.
4. Startup fails closed on missing artifacts, missing disks, port conflicts,
   unavailable KVM, cloud-init/SSH timeout or unhealthy services. It never
   substitutes a fake ready state.
5. Every fast path has the authoritative provisioning path as its fallback.
6. Project VM state (disk, SSH identity, seed identity, runtime secrets) is
   backed up as one recovery unit.
7. A project runtime is bound to the architecture that created it. Startup in
   the other mode skips automatic restore and explicit provisioning fails with
   an actionable error; it never runs two VMs for one project, overwrites the
   other descriptor, or steals its ports. Switching requires stopping/removing
   the owning runtime and restoring project data into the new VM.

## Documents per mode

Each mode directory contains:

- `README.md` — architecture, lifecycle, security, support matrix;
- `operations.md` — build, start, backup/restore, failure recovery and
  validation commands.

Shared runtime standards remain in
[`../standards/04-runtime-lifecycle.md`](../standards/04-runtime-lifecycle.md).
