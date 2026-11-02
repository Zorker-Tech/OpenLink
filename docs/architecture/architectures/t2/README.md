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

1. Build the T2 base with the Ubuntu 26.10 worker userspace, the T2 RDP
   bridge packages, Google Chrome 156, agent-desktop 1.0.2, Noto CJK fonts and the bundled
   Astreusn Ubuntu wallpaper set. The builder fails if any first-run
   dependency is missing or fails its version check.
2. Boot with the verified 24.04 LTS generic kernel/initrd and virtio-gpu.
3. Start the systemd user manager and user D-Bus bus.
4. Start Ubuntu's `gnome-session@ubuntu.target`. A systemd user drop-in runs
   `org.gnome.Shell@ubuntu.service` as `gnome-shell --headless --no-x11
   --virtual-monitor 1280x800 --mode=ubuntu`, so the shell, settings daemons,
   portals and session manager are one managed Ubuntu session.
5. Start an empty-password keyring and GNOME Remote Desktop's RDP server.
6. Configure a self-signed TLS certificate and random per-VM RDP password.
7. Bridge RDP into Xvfb `:9` with FreeRDP, then expose x11vnc/websockify.
8. Set the light/dark Astreusn wallpapers and make Chrome the default browser.
9. Start the same project services and Supabase stack as T1.

## Security and limits

- RDP listens only on the guest loopback; the host desktop forward remains
  loopback-only.
- The RDP certificate is self-signed and used only by the local FreeRDP bridge.
- Xvfb `:9` is separate from the headless shell's Xwayland displays `:0/:1`.
- T2 disables Xwayland (`--no-x11`) because GNOME Shell 51 headless Xwayland
  exits under the current virtual GPU. **X11 applications are not supported**
  in the T2 desktop; use Wayland applications or T1.
- The Ubuntu Dock, desktop icons, AppIndicators and Tiling Assistant extensions
  are enabled. The dock is fixed to the left so the desktop is complete and
  discoverable over RDP.
- X11-only launchers inherited from the E1 worker userspace (Xfce, XTerm,
  xfreerdp) are hidden. T2 runs `--no-x11`; use Wayland applications or T1.
- GNOME's screen-sharing and screen-recording top-bar indicators are hidden.
  In T2 the RDP surface is the only display; the indicator's stop action
  terminates that surface and leaves a black desktop.
- The session is Wayland, but the internal RDP-to-VNC bridge uses Xvfb/x11vnc.
  Settings may report `Graphics: Software Rendering` because the headless
  virtio-gpu has no hardware EGL/3D path; this is the renderer, not an X11
  desktop session.
- Chrome is the default browser and runs with the Wayland ozone backend; the
  image launcher passes `--ozone-platform=wayland` because Xwayland is off.
- agent-desktop 1.0.2 is installed from its pinned Apache-2.0 release archive.
  The real binary runs in the Project VM host's PID namespace and exposes a
  constrained Unix socket. Agent session containers receive only a CLI shim
  and the socket, then discover the tool through the injected
  `agent-desktop` skill. Its source is vendored at `services/agent-desktop`
  with full upstream history.
- CLI tools are exposed through the project tool registry described by
  [standard 09](../../standards/09-agent-tool-registry.md); the registry is
  mounted read-only at `/openlink/agent-tools` and travels with an
  architecture switch.
- The bundled wallpaper set lives under
  `/usr/share/backgrounds/astreusn`; `astreusn.xml` registers the light/dark
  pair with the GNOME background picker.
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
