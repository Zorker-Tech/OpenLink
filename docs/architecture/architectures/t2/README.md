# T2 — Ubuntu 26.10 GNOME 51 Wayland preview

Status: preview (`T2-Orion-0.0.1`)
Decision: [ADR-0030](../../ADR-0030-t2-orion-wayland-preview.md)
Release: [T2-Orion-0.0.1](../../standards/08-release-versioning.md)

T2 is the preview Project computer architecture. It tracks the latest Ubuntu
release and GNOME Wayland, and deliberately changes the desktop transport
route. It is selectable with `-t2`/`--arch=t2`; T1 remains the default.

## Topology

```text
Browser
  → Next.js Web/BFF
      → Agent Host (OPENLINK_ARCHITECTURE=t2)
          → Ubuntu 26.10 Project VM (QEMU/KVM, virtio-gpu)
              ├─ project services: OpenSandbox, Browser Host, code-server,
              │                    project Supabase
              ├─ GNOME Shell 51 headless Wayland display server
              ├─ GNOME Remote Desktop RDP server (127.0.0.1:3389)
              ├─ FreeRDP client → Xvfb :9
              ├─ x11vnc :9 → websockify :6080
              └─ OpenSandbox sessions: Agent Worker / Pi / Codex
```

The public desktop surface remains the existing noVNC/Desktop Gateway. The
T2-specific bridge is inside the Project VM:

```text
GNOME 51 Wayland → PipeWire screencast → RDP → FreeRDP → Xvfb → x11vnc → noVNC
```

## Contracts

- `OPENLINK_ARCHITECTURE=t2`
- `OPENLINK_PROJECT_VM_DRIVER=ubuntu-qemu`
- `OPENLINK_PROJECT_VM_BASE_DISK=<project-vm-base/t2>/...qcow2`
- `OPENLINK_PROJECT_VM_KERNEL` / `OPENLINK_PROJECT_VM_INITRD`
- `OPENLINK_PROJECT_VM_STATE_ROOT=.openlink-runtime/project-vms/t2`
- `OPENLINK_PROJECT_VM_GUEST_USER=openlink`
- `OPENLINK_PROJECT_VM_GUEST_WORKSPACE_ROOT=/home/openlink/openlink/projects`
- `OPENLINK_DESKTOP_MODE=wayland-rdp`
- `OPENLINK_DESKTOP_SCOPE=project`
- QEMU exposes `virtio-gpu-pci` so Mutter can create a GBM renderer and EGL
  screencast path.

## Lifecycle

1. Build the T2 base with the Ubuntu 26.10 worker userspace and the T2 RDP
   bridge packages.
2. Boot with the verified 24.04 LTS generic kernel/initrd and virtio-gpu.
3. Start the systemd user manager and user D-Bus bus.
4. Start GNOME Shell 51 with `--headless --no-x11 --virtual-monitor 1280x800 --mode=user`.
5. Start an empty-password keyring and GNOME Remote Desktop's RDP server.
6. Configure a self-signed TLS certificate and random per-VM RDP password.
7. Bridge RDP into Xvfb `:9` with FreeRDP, then expose x11vnc/websockify.
8. Start the same project services and Supabase stack as T1.

## Security and limits

- RDP listens only on the guest loopback; the host desktop forward remains
  loopback-only.
- The RDP certificate is self-signed and used only by the local FreeRDP bridge.
- Xvfb `:9` is separate from the headless shell's Xwayland displays `:0/:1`.
- T2 disables Xwayland (`--no-x11`) because GNOME Shell 51 headless Xwayland
  exits under the current virtual GPU. **X11 applications are not supported**
  in the T2 desktop; use Wayland applications or T1.
- Ubuntu Shell extensions that assume a GDM seat are disabled; T2 runs vanilla
  GNOME Shell with one OpenLink extension.
- GNOME's screen-sharing and screen-recording top-bar indicators are hidden.
  In T2 the RDP surface is the only display; the indicator's stop action
  terminates that surface and leaves a black desktop.
- T2 is preview: no stability or migration SLA beyond the supported one-command
  switch.

## Failure and recovery

- `openlink-desktop.service` restarts GNOME Shell, RDP, FreeRDP, Xvfb and
  websockify after a component crash.
- The keyring is recreated and unlocked on each start; RDP credentials are set
  from the per-VM password file.
- A missing T2 base, base/disk mismatch, KVM failure or missing keyring/RDP
  component fails closed; it never falls back to Xfce or T1.
- T1↔T2 data migration is supported by the one-command switch.

## Validation

```bash
pnpm runtime:t2-vm-image
pnpm dev:local:t2
curl -sf http://127.0.0.1:43121/healthz
curl -sf http://127.0.0.1:<desktop-port>/vnc.html
```

See [operations.md](./operations.md).
