# Project computer architectures

OpenLink has one durable Project VM per project. The desktop and session
topology are selected explicitly at startup. This directory is the index for
the supported runtime architectures; the binding decisions are
[ADR-0029](../ADR-0029-project-computer-t1-e1-modes.md) for T1/E1 and
[ADR-0030](../ADR-0030-t2-orion-wayland-preview.md) for the T2 preview.

## Modes

| Mode | Status | Project VM | Desktop | Startup |
| --- | --- | --- | --- | --- |
| [`t1`](./t1/README.md) | Default, stable | Ubuntu 24.04 LTS Project VM (GNOME 46 X11 + LTS generic kernel) + rootful Podman | One native Ubuntu project desktop shared by all chats | `pnpm dev:local`, `-t1` |
| [`t2`](./t2/README.md) | Preview, explicit | Ubuntu 26.10 Project VM (GNOME 51 Wayland + RDP bridge) + rootful Podman | One native GNOME 51 Wayland desktop shared by all chats | `pnpm dev:local:t2`, `-t2` |
| [`e1`](./e1/README.md) | Optional, compatibility | Podman machine OS + rootful Podman | Per-chat container desktop (Xvfb + GNOME/Xfce) | `-e1` |
| experimental ISO | Not a product support commitment | Session container + nested QEMU/KVM | Full Ubuntu Desktop guest per chat | Explicit legacy configuration only |

## Selection

`scripts/openlink.mjs` owns the selection:

```bash
pnpm dev:local          # T1 (default)
pnpm dev:local:t2       # T2 preview
pnpm dev:local:e1       # E1
node scripts/openlink.mjs --mode development --profile local --arch e1
node scripts/openlink.mjs --mode production -t1
```

The resolved mode is exported as `OPENLINK_ARCHITECTURE` (`t1`, `t2` or `e1`). The
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
7. User-installed CLI tools are exposed only through the project-scoped
   `/var/lib/openlink/agent-tools` registry, mounted read-only as
   `/openlink/agent-tools` with its `bin` directory on `PATH`. Host PATH and
   package-manager trees are never mounted into a sandbox.
8. A project runtime is bound to the architecture that created it. T1 and T2
   share the qemu-kvm backend but use separate state roots and release
   identities. Startup in the other mode skips automatic restore and explicit
   provisioning fails with an actionable error; it never runs two VMs for one
   project, overwrites the other descriptor, or steals its ports. Switching
   requires the one-command migration or stopping/removing the owning runtime.

## Switching architectures

A project runtime is bound to the architecture that created it, so switching is
an explicit maintenance operation, not a live migration. The supported
one-command workflow stops the OpenLink app, quiesces the source VM, exports and
verifies the project data, archives the source runtime descriptor, provisions
the target architecture, imports and re-verifies the data, and only then reports
success. The source VM disk is retained; on any failure the command stops the
target and restarts the source from its archived descriptor.

```bash
# Stop the app first.
npm run runtime:switch -- --project <project-uuid> --to e1
npm run runtime:switch -- --project <project-uuid> --to t1
npm run runtime:switch -- --project <project-uuid> --to e1 --dry-run
```

Data moved by the command:

- the complete project workspace, including `.openlink` session/browser state;
- Project Supabase `data/`, `configuration/` and `secrets.json`;
- the runtime's OpenSandbox/Browser capability tokens.

Active chat leases are not resumed across a switch; sessions are quiesced and
the workspace state remains. The command writes a self-describing backup under
`.openlink-runtime/project-migrations/<projectId>/<timestamp>/` with
`manifest.json`, archive SHA-256/size, source runtime files and a
`migration.json` outcome. It never deletes the source VM disk. Repeating the
command in the other direction exports the target's current data back, so the
target becomes the new source of truth.

The app must be stopped for a normal switch. `--allow-running-app` exists only
for an external maintenance orchestrator that has already fenced project
traffic; it is not safe for interactive use.

## Documents per mode

T2 is a preview channel; its support and compatibility surface is narrower
than T1. E1 remains the compatibility mode. Each mode directory contains:

- `README.md` — architecture, lifecycle, security, support matrix;
- `operations.md` — build, start, backup/restore, failure recovery and
  validation commands.

Shared runtime standards remain in
[`../standards/04-runtime-lifecycle.md`](../standards/04-runtime-lifecycle.md).
