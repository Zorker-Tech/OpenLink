# T2 operations and support

Decision: [ADR-0030](../../ADR-0030-t2-orion-wayland-preview.md)
Architecture: [README.md](./README.md)

## Prerequisites

- Linux x86_64 with `/dev/kvm`, QEMU, OpenSSH, `qemu-img`, `mke2fs`.
- Docker for the Ubuntu 26.10 userspace image and runtime archives.
- The T2 base artifact under `.openlink-runtime/project-vm-base/t2/`.
- The Project Supabase seed at `.openlink-runtime/project-supabase/cache/seed.json`.

T2 is Linux-only in this release. It requires the Ubuntu 26.10 userspace image
(`openlink/agent-worker:dev`) and the verified Ubuntu 24.04 LTS generic kernel.

## Build

```bash
pnpm runtime:t2-vm-image
```

The builder installs GNOME 51, GNOME Remote Desktop, FreeRDP, Xvfb, x11vnc,
websockify and gnome-keyring into the 26.10 userspace, adds the Project VM
runtime and Supabase images, and publishes a content-addressed qcow2 plus
kernel/initrd manifest. The T2 manifest desktop session is
`ubuntu-gnome-51-wayland-rdp`.

## Start

```bash
pnpm dev:local:t2
# or
node scripts/openlink.mjs --mode development --profile local --arch t2
```

T1 remains the default. T2 uses a separate Project VM state root
`.openlink-runtime/project-vms/t2`, so a T1 and T2 runtime cannot overwrite
each other's descriptor. Do not run both modes for the same project at once.

## Desktop checks

```text
guest: systemctl status openlink-desktop
guest: systemctl --user status gnome-session@ubuntu.target org.gnome.Shell@ubuntu.service
guest: pgrep -a gnome-shell
guest: pgrep -a gnome-remote-de
guest: pgrep -a xfreerdp
guest: pgrep -a x11vnc
guest: ss -lnt | grep -E ':(3389|5900|6080)\b'
host:  curl -sf http://127.0.0.1:<desktop-port>/vnc.html
```

The RDP password is in `/var/lib/openlink/project-desktop/rdp/password` inside
the guest. The TLS certificate/key are in the same directory, mode 0600. The
RDP port is loopback-only.

## Failure recovery

| Symptom | Action |
| --- | --- |
| T2 base missing | `pnpm runtime:t2-vm-image`; startup fails closed |
| GNOME Shell crash | systemd `OnFailure` shuts down the user session; `openlink-desktop` exits and restarts a clean `gnome-session@ubuntu.target`. Verify the session units and VNC endpoint |
| Dock missing | Verify the Ubuntu Dock extension is enabled and `dock-position` is `LEFT`; restart `openlink-desktop` |
| RDP not listening | Check `gnome-remote-desktop.service`, keyring, certificate and `gnome-shell`; the bridge only starts after RDP listens |
| Keyring locked | The service recreates and unlocks an empty login keyring at every start; check `org.freedesktop.secrets` on the user bus |
| VNC endpoint 200 but no desktop | Check FreeRDP/Xvfb `:9`; RDP must be healthy first |
| Desktop turns black after clicking the orange top-bar pill | The GNOME screen-sharing indicator was stopped. T2 loads `openlink-headless@openlink`, which hides the screen-sharing/recording indicators; verify `gnome-extensions info openlink-headless@openlink` reports `Enabled: Yes` and restart `openlink-desktop` if needed |
| X11 app cannot start | T2 runs `--no-x11`; use T1 or a Wayland app |
| Port conflict | Stop the conflicting process or restart provisioning; T2 uses the same port allocator as T1 |
| Project deletion | Remove the T2 VM state root and project runtime state; the shared base remains |

## Migration

T2 participates in the one-command switch:

```bash
npm run runtime:switch -- --project <uuid> --to t2 --from t1
npm run runtime:switch -- --project <uuid> --to t1 --from t2
```

The command closes the desktop/service pipeline, exports workspace and Project
Supabase state, archives the source runtime descriptor, provisions the target
base (including virtio-gpu for T2), imports data, and verifies the desktop and
services. Source VM disks and backups are retained.

## Validation

```bash
npm --prefix services/agent-host test
npm run runtime:project-supabase:test
npm run runtime:architecture:test
```

Scenario coverage: cold T2 boot, desktop component crash/restart, stop/start,
guest reboot, QEMU crash, Supabase health, T1→T2 and T2→T1 data migration.
