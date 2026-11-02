# T1 — Ubuntu Project VM with a native project desktop

Status: default architecture
Decision: [ADR-0029](../ADR-0029-project-computer-t1-e1-modes.md)

## What T1 is

One project owns one durable Ubuntu QEMU/KVM VM. The userspace is the pinned
Ubuntu 24.04 LTS desktop image; the kernel is the verified Ubuntu 24.04 LTS
generic kernel passed directly to QEMU:

```text
Browser
  → Next.js Web/BFF
      → Agent Host
          → T1 Project VM (Ubuntu LTS, native desktop, rootful Podman)
              ├─ native desktop: Xvfb + Ubuntu GNOME 46 (X11) + x11vnc + websockify :6080
              ├─ project services: OpenSandbox control plane, Browser Host, code-server,
              │                    project Supabase
              └─ OpenSandbox sessions: Agent Worker / Pi / Codex, Browser Host,
                                       code-server workbenches
```

The native desktop is a **project-level resource**. Every chat in the project
uses the same desktop endpoint through the existing authenticated Desktop
Gateway. Chats remain isolated OpenSandbox session workloads; they do not own
an OS and do not start their own desktop.

## Why this replaces per-chat nested desktops

- nested KVM is not a reliable product prerequisite (WSL2 and many cloud hosts
  fail or soft-lock the inner guest);
- per-chat full OS instances multiply RAM, disk, install time, patching and
  backup work;
- a project computer should persist across chats so the user and agents share
  the same browser, windows, files and tool state;
- one VM per project is one unit for snapshot, backup, quota, audit and
  recovery.

## Durable state

| State | Location | Owner | Backup |
| --- | --- | --- | --- |
| Project disk overlay | `<stateRoot>/ubuntu-vms/<machine>/disk.qcow2` | Agent Host | Required |
| Per-project SSH identity | `<stateRoot>/ubuntu-vms/<machine>/id_ed25519{,.pub}` | Agent Host | Required |
| Seed identity and seed disk | `<stateRoot>/ubuntu-vms/<machine>/{seed.json,seed/**,seed.img}` | Agent Host | Required |
| VM spec | `<stateRoot>/ubuntu-vms/<machine>/vm.json` | Agent Host | Required |
| Project runtime descriptor/secrets/ports | `<stateRoot>/projects/<projectId>/` | Agent Host | Required |
| Project workspace | guest `/home/openlink/openlink/projects/<projectId>/workspace` | inside the overlay | via VM backup |
| Immutable Ubuntu base + kernel/initrd | `.openlink-runtime/project-vm-base/ubuntu/` | artifact producer | Not per-project |

The base is versioned by content (`ubuntu-project-vm-base-<sha>.qcow2`). A
project records the base path it was created from. A base upgrade publishes a
new file and never rewrites an existing project disk. Deleting a project
removes its overlay, SSH identity and runtime state; the shared base remains.

## Lifecycle

1. **Artifact verification.** The supervisor validates the T1 manifest, the
   base qcow2, platform/architecture and the expected virtual size.
2. **Project disk.** A thin qcow2 overlay is created with the verified base as
   its backing file. `thick` mode creates an independent qcow2 copy.
3. **Identity.** A per-project ed25519 key is generated (or adopted) under the
   project VM state directory.
4. **Seed.** A per-project instance-id, public key and random seed token are
   written to a read-only ext4 seed disk.
5. **Boot.** QEMU starts with loopback-only host forwards, the seed disk
   attached as `/dev/vdb`, a serial log, a QMP socket and a pid file. The VM is
   not started if any required port is occupied.
6. **Cloud-init.** The seed disk is mounted at
   `/var/lib/cloud/seed/nocloud`, the project public key is injected,
   `podman.socket` is enabled, and the native desktop service starts. The base
   also carries Google Chrome and agent-desktop; the desktop service makes
   Chrome the default browser, applies the Astreusn light/dark wallpapers and
   starts the agent-desktop Unix-socket bridge. Agent sessions receive a CLI
   shim plus that socket, not the host desktop runtime.
7. **Readiness.** SSH becomes reachable; Agent Host verifies passwordless sudo
   and rootful Podman.
8. **Project services.** Agent Host waits for the immutable Project Supabase
   images to load from the base (one-time local `podman load`), imports runtime
   image archives, starts the project Supabase stack, OpenSandbox, Browser Host
   and code-server, and publishes the project desktop endpoint.
9. **Sessions.** Chat leases create OpenSandbox session containers inside the
   VM. The session `desktopEndpoint` returns the project desktop URL.

## Runtime contracts

- `OPENLINK_PROJECT_VM_DRIVER=ubuntu-qemu`
- `OPENLINK_PROJECT_VM_BASE_DISK=<versioned base qcow2>`
- `OPENLINK_PROJECT_VM_BASE_FINGERPRINT=<manifest fingerprint>`
- `OPENLINK_PROJECT_VM_GUEST_USER=openlink`
- `OPENLINK_PROJECT_VM_GUEST_WORKSPACE_ROOT=/home/openlink/openlink/projects`
- `OPENLINK_PROJECT_VM_KERNEL=<verified vmlinuz>`
- `OPENLINK_PROJECT_VM_INITRD=<verified initrd>`
- `OPENLINK_MKE2FS_COMMAND=/usr/sbin/mke2fs` (seed disk creation)
- `OPENLINK_DESKTOP_SCOPE=project`
- `OPENLINK_DESKTOP_MODE=ubuntu-container` (session desktop is not started for
  T1; the project desktop is returned instead)
- `OPENLINK_PROJECT_RUNTIME_DESKTOP_PORT_OFFSET=6000`
- QEMU host forwards: SSH, six project service ports, and
  `<desktopPort> → guest 6080`.

The project runtime descriptor carries `desktopEndpoint`. The Desktop Gateway
registers that endpoint for the chat; the session runtime never calls the
worker's `/desktop/start`.

## Security

- The Project VM is the host boundary. QEMU exposes only loopback host ports.
- Project service containers publish on the guest interface so QEMU user-mode
  hostfwd can reach them; the guest has no bridged external interface and the
  host forwards remain `127.0.0.1`-only.
- The desktop VNC server binds guest loopback; websockify is reachable only
  through the project desktop port and the authenticated Desktop Gateway.
- Session workloads remain isolated by OpenSandbox inside the VM.
- Google Chrome is installed from a pinned package. T1 runs the X11 backend
  because its GNOME 46 session is under Xvfb.
- agent-desktop 1.0.2 runs in the Project VM host's PID namespace behind a
  constrained Unix socket. Session containers receive only a CLI shim and the
  socket; the real binary never runs inside the sandbox. Its source is vendored
  at `services/agent-desktop`.
- The per-project SSH key never enters the guest, a session workload, the
  browser or logs.
- The build removes the build key, cloud-init seed state, machine-id and SSH
  host keys; clones generate fresh identities.
- The cloud-init seed is a read-only ext4 disk containing only public
  metadata. There is no seed HTTP listener or SMBIOS data source.

## Failure and recovery

| Failure | Behavior |
| --- | --- |
| Missing base artifact | Startup fails with an actionable build instruction; `-e1` remains available |
| Missing project disk with durable state | Fail closed; restore from backup or explicitly recreate; never silently reprovision |
| QEMU crash | Next ensure restarts the same disk and waits for SSH |
| Agent Host restart | Persisted runtime fast-reattach; running services are adopted |
| Host reboot | VM is stopped; persisted runtime sweep starts it on demand |
| Port conflict | Retryable provisioning error; the manager reallocates persisted ports where possible |
| Cloud-init/SSH timeout | Start is aborted, QEMU is stopped, console log tail is reported |
| Desktop service crash | systemd restarts the desktop session |
| Project deletion | Removes overlay, identity, seed and runtime state; keeps the shared base |

## Support matrix

| Host | T1 | Notes |
| --- | --- | --- |
| Linux with QEMU/KVM | Supported | Includes a Linux host provided by WSL2; WSL itself is not the Project VM |
| macOS AppleHV | Not in this release | Use E1; a native T1 driver is future work |
| Windows Hyper-V | Not in this release | Use E1; a native T1 driver is future work |

## Build and verification

```bash
pnpm runtime:ubuntu-vm-image     # compose the immutable Ubuntu base
pnpm dev:local                   # T1 default
pnpm dev:local:e1                # E1 explicit
npm --prefix services/agent-host test
node --test services/agent-host/dist/test/project-vm-ubuntu.test.js
```

See [`operations.md`](./operations.md) for artifact, backup, recovery and
full-scenario validation procedures.
