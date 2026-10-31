# E1 — Podman Project VM with per-chat container desktop

Status: optional, explicit (`-e1`)
Decision: [ADR-0029](../ADR-0029-project-computer-t1-e1-modes.md)

E1 is the previous isolation model, retained as a supported explicit mode. It
is not the default. It keeps the heavier per-session isolation and uses a
container desktop for each chat; it does not start the Ubuntu ISO desktop.

## Topology

```text
Browser
  → Next.js Web/BFF
      → Agent Host
          → Project VM (Podman machine OS, rootful Podman)
              ├─ project services: OpenSandbox control plane, Browser Host,
              │                    code-server, project Supabase
              └─ OpenSandbox session per chat
                  ├─ Agent Worker / Pi / Codex
                  ├─ Browser Host workbench
                  └─ container desktop: Xvfb + GNOME/Xfce + x11vnc + websockify
```

The desktop is **session-scoped**. Each chat owns its own container desktop
process inside its session workload. An idle chat may suspend its own desktop;
it cannot affect another chat.

## Why keep E1

- Per-chat GUI/process isolation is stronger than a shared project desktop.
- It works on the existing native host drivers: Linux QEMU, macOS AppleHV,
  Windows Hyper-V.
- It does not require a full Ubuntu guest or a project-level desktop service.
- It remains the support path on hosts without a T1 native driver.

Cost: every chat that needs a desktop runs its own GUI stack, X server, VNC and
websockify process. Density is lower than T1 and resource use is per chat.

## Contracts

- `OPENLINK_PROJECT_VM_DRIVER=podman-machine`
- `OPENLINK_DESKTOP_SCOPE=session`
- `OPENLINK_DESKTOP_MODE=ubuntu-container`
- `OPENLINK_PROJECT_VM_GUEST_USER=core`
- `OPENLINK_PROJECT_VM_GUEST_WORKSPACE_ROOT=/home/core/openlink/projects`
- Session runtime `desktopEndpoint()` starts and returns the per-session
  container desktop; no project-level `desktopEndpoint` is published.

The ISO desktop code (`ubuntu-iso`, golden qcow2 + overlay) is retained as an
experimental legacy surface but is **not selected by E1** and must not be used
as a product default.

## Lifecycle

1. The Podman machine Project VM is ensured/started from its versioned base.
2. Project services (Supabase, OpenSandbox, Browser Host, code-server) are
   started and health-checked.
3. A chat lease creates an OpenSandbox session workload.
4. Desktop prewarm calls the session's `/desktop/start`, which launches
   Xvfb/GNOME or Xfce, x11vnc and websockify inside that workload.
5. Idle desktop suspend applies per session.

## Operations

```bash
pnpm dev:local:e1
node scripts/openlink.mjs --mode development --profile local --arch e1
```

- Artifact production: existing Podman Project VM base/disk and runtime image
  commands (`pnpm runtime:vm-image`, `pnpm runtime:images`).
- Backup: the Podman machine disk and the project runtime state
  (`runtime.json`, `runtime-secrets.json`, `ports.json`) are one recovery unit.
- A stale session workload port conflict must remove that session workload; it
  must not block Project VM activation.
- Switching a project to T1 is not an in-place migration. Keep the E1 VM as a
  backup/workspace source; T1 creates a separate Ubuntu Project VM.

See [T1 operations](../t1/operations.md) for the shared validation checklist and
[ADR-0029](../ADR-0029-project-computer-t1-e1-modes.md) for the decision and
failure/rollback contract.
