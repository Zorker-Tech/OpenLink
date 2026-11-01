# E1 operations and support

Decision: [ADR-0029](../../ADR-0029-project-computer-t1-e1-modes.md)
Architecture: [README.md](./README.md)

## Prerequisites

- Linux: Podman machine QEMU/KVM and the bundled Podman toolchain.
- macOS: AppleHV with the bundled vfkit/gvproxy artifacts.
- Windows: Hyper-V with the prepared host toolchain.
- Runtime image archives and the Podman Project VM base/disk artifacts must be
  present. Ordinary startup must not pull a machine OS or rebuild images.

## Selection

```bash
pnpm dev:local:e1
node scripts/openlink.mjs --mode development --profile local -e1
node scripts/openlink.mjs --mode production --profile local --arch e1
```

E1 forces `OPENLINK_DESKTOP_MODE=ubuntu-container` and
`OPENLINK_DESKTOP_SCOPE=session`; it does not start the Ubuntu ISO desktop.

## Desktop lifecycle

- Prewarm starts the per-chat container desktop after the chat lease.
- `OPENLINK_DESKTOP_PREWARM=0` disables prewarm.
- `OPENLINK_DESKTOP_PREWARM_MAX` bounds concurrent prewarmed desktops
  (default 1) because each desktop consumes session CPU/RAM.
- Idle suspend applies per chat and never affects another chat.
- If the desktop process exits, the session endpoint restarts it on the next
  request.

## Switching architectures

An E1 project runtime is bound to E1. Starting T1 against the same project
skips the automatic restore and fails explicit provisioning with the recorded
architecture in the error; it does not start an Ubuntu VM or take over E1
ports. To move a project to T1: back up the project workspace and Supabase
data, remove the Podman machine and `projects/<projectId>/`, provision under
T1, then restore the data.

## Failure recovery

| Symptom | Action |
| --- | --- |
| Project VM start failed | Inspect the Podman machine state; the base disk and machine config are durable |
| Session workload port conflict | Remove the exact session workload; do not fail the whole Project VM |
| Desktop unavailable | Inspect the session worker `/desktop/status` and its container logs; restart the session desktop |
| Agent Host restart | Durable session leases recover workers; persisted project runtime fast-reattach applies |
| Host reboot | Podman machine is restarted on demand; service containers use restart policies |
| Supabase services report `lookup db ... i/o timeout` or `network is unreachable` | Verify `aardvark-dns` is present in the machine OS. Project containers pin `--dns-search dns.podman`; a host search domain must not be allowed to answer project names with an IPv6 address on the IPv4-only container network |
| `lifecycle operation ... is already running` after a VM restart | The controller lock is boot-id aware; a lock from an earlier boot is stale even if its PID was reused. If an older controller still blocks, remove `/var/lib/openlink/project-supabase/.lifecycle.lock` in the VM and rerun provisioning |
| Project deletion | Remove the Podman machine, its disk and the project runtime state; keep versioned base artifacts |

## Validation

```bash
pnpm dev:local:e1
curl -sf http://127.0.0.1:43121/healthz
curl -sf http://127.0.0.1:43120/healthz
npm --prefix services/agent-host test
```

Scenario coverage must include: cold Project VM boot, VM stop/start, Agent Host
restart, host reboot, stale workload/port conflict, desktop process crash,
idle suspend/resume, and project deletion.
