# T1 operations and support

Decision: [ADR-0029](../../ADR-0029-project-computer-t1-e1-modes.md)
Architecture: [README.md](./README.md)

## Prerequisites

- Linux x86_64 or arm64 host with:
  - `/dev/kvm` readable and writable by the OpenLink process;
  - `qemu-system-x86_64` (or the matching architecture), `qemu-img`;
  - `ssh`, `scp`, `ssh-keygen`;
  - Node.js 22.19+;
  - Docker Desktop/engine for the local ZOKERBASE stack and runtime image
    archive production.
- The T1 base artifact must be built before the first startup. Ordinary
  startup must never download a cloud image or install a desktop.

## Artifact production

```bash
pnpm runtime:ubuntu-vm-image
```

The builder:

1. downloads the official Ubuntu 24.04 cloud image and verifies its SHA-256
   against the published `SHA256SUMS`;
2. creates a 64 GiB qcow2 overlay on the host KVM;
3. boots it with a loopback cloud-init seed; cloud-init installs rootful
   Podman, SSH, Node.js, Git, Xvfb, GNOME/Xfce, x11vnc and websockify;
4. verifies the native desktop endpoint, Podman, SSH and service enablement;
5. removes the build identity, cloud-init state, machine-id and SSH host keys;
6. collapses the disk to a standalone qcow2, runs `qemu-img check`, and
   publishes a content-addressed artifact plus `manifest.json`.

Environment:

| Variable | Purpose |
| --- | --- |
| `OPENLINK_UBUNTU_CLOUD_IMAGE_URL` | Override the official cloud image URL |
| `OPENLINK_UBUNTU_CLOUD_CACHE` | Cloud image cache (default `~/.cache/openlink/ubuntu-cloud`) |
| `OPENLINK_UBUNTU_PROJECT_VM_OUTPUT` | Artifact directory (default `.openlink-runtime/project-vm-base/ubuntu`) |
| `OPENLINK_UBUNTU_APT_MIRROR` | Optional apt mirror URL |
| `OPENLINK_UBUNTU_VM_BUILD_TIMEOUT_MS` | Build timeout (default 60 min) |
| `OPENLINK_UBUNTU_BUILD_MEMORY_MB` / `_CPUS` | Build guest resources |
| `OPENLINK_UBUNTU_PROJECT_VM_DISK_GB` | Base virtual size (default 64) |

The artifact is immutable (`0444`). Never edit or boot it directly; projects
boot overlays.

## Start and select the mode

```bash
pnpm dev:local          # T1 default
pnpm dev:local:t1       # explicit T1
pnpm dev:local:e1       # E1
pnpm start:t1           # production T1
pnpm start:e1           # production E1
node scripts/openlink.mjs --mode development --profile local --arch t1
```

The supervisor validates the artifact before starting the Agent Host. A
missing or mismatched artifact is a startup error; ordinary startup never
falls back silently to a different architecture.

## Project VM state

State is rooted at `OPENLINK_PROJECT_VM_STATE_ROOT` (default
`.openlink-runtime/project-vms`):

```text
project-vms/
  ubuntu-vms/<machine>/
    disk.qcow2          # project overlay (or thick independent copy)
    id_ed25519(.pub)    # per-project SSH identity
    seed.json           # instance-id + seed token
    vm.json             # machine spec, base path/fingerprint, ports
    qemu.pid            # daemonized QEMU pid
    console.log         # guest serial console
  projects/<projectId>/
    runtime.json
    runtime-secrets.json
    ports.json
```

QMP sockets live in a short `tmpdir()` path to stay within `sockaddr_un`
limits.

## Backup and restore

Back up, per project:

- `ubuntu-vms/<machine>/` (`disk.qcow2`, `id_ed25519`, `seed.json`, `vm.json`);
- `projects/<projectId>/` (`runtime.json`, `runtime-secrets.json`,
  `ports.json`).

Do **not** back up the shared base per project. The base is reproducible from
`pnpm runtime:ubuntu-vm-image` and is content-addressed.

Restore:

1. stop the project runtime (or the whole Agent Host);
2. restore the state directories with the same ownership and modes;
3. ensure the recorded base file still exists (or restore the matching
   versioned base from the artifact backup);
4. start the stack; the persisted runtime sweep reattaches a running VM or
   starts it from the same disk.

A missing disk with a durable `vm.json` fails closed. To recreate from
scratch, remove the project's `ubuntu-vms/<machine>/` directory **and** its
`projects/<projectId>/runtime.json`, then let provisioning run. This is a
destructive recovery; restore from backup first when the data matters.

## Failure recovery

| Symptom | Action |
| --- | --- |
| `T1 requires ... /dev/kvm` | Enable host KVM and ensure the process can access it, or use `-e1` |
| `T1 Ubuntu Project VM image manifest is missing` | `pnpm runtime:ubuntu-vm-image` |
| `disk is missing` | Restore the project disk or explicitly recreate the project runtime |
| `host port ... already in use` | Stop the conflicting process or restart provisioning; persisted ports are reallocated when possible |
| `did not become reachable` | Inspect `console.log`; check QEMU started, cloud-init seed server was reachable, and the guest can DHCP |
| Desktop unreachable | `ssh ... systemctl status openlink-desktop`; inspect `/tmp/openlink-*.log` in the guest |
| Cloud-init failed | The console log and `/var/log/cloud-init-output.log` identify the module; fix the base artifact or the host network |
| Project services unhealthy | The existing project Supabase/OpenSandbox logs and health probes apply; a stale session container is removed rather than blocking the VM |

Never delete the event log or silently recreate a project disk to make a
health check green.

## Validation checklist

```bash
# 1. Artifact and manifest
node -e "const m=require('./.openlink-runtime/project-vm-base/ubuntu/manifest.json'); console.log(m.disk, m.baseFingerprint)"
qemu-img info .openlink-runtime/project-vm-base/ubuntu/ubuntu-project-vm-base-*.qcow2

# 2. Agent Host unit/integration tests
npm --prefix services/agent-host test

# 3. T1 driver tests
node --test services/agent-host/dist/test/project-vm-ubuntu.test.js

# 4. Full local startup
pnpm dev:local

# 5. Runtime health
curl -sf http://127.0.0.1:43121/healthz
# 6. Persisted descriptor
cat .openlink-runtime/project-vms/projects/<projectId>/runtime.json
```

Scenario tests should cover: first boot, stop/start, Agent Host restart,
host reboot, QEMU crash, missing disk, port conflict, desktop restart, stale
session workload, and project deletion. Each must leave a recoverable state
and an explicit error/status projection.
