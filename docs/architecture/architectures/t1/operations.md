# T1 operations and support

Decision: [ADR-0029](../../ADR-0029-project-computer-t1-e1-modes.md)
Architecture: [README.md](./README.md)

## Prerequisites

- Linux x86_64 or arm64 host. To **run** T1:
  - `/dev/kvm` readable and writable by the OpenLink process;
  - `qemu-system-x86_64` (or the matching architecture), `qemu-img`;
  - `ssh`, `scp`, `ssh-keygen`;
  - Node.js 22.19+;
  - Docker Desktop/engine for ZOKERBASE and runtime image archives.
- To **build** the artifact: Docker, `qemu-img`, `sfdisk`, `dd`, `debugfs`
  (e2fsprogs). KVM is not required for the build.
- The T1 base artifact must be built before the first startup. Ordinary
  startup must never download a cloud image or install a desktop.

## Artifact production

```bash
pnpm runtime:ubuntu-vm-image
```

The builder:

1. verifies the official Ubuntu 24.04 cloud image and extracts the Ubuntu LTS
   generic kernel, initrd and matching modules;
2. installs rootful Podman, SSH, cloud-init, network/netfilter tools and the
   Project Supabase runtime dependencies into the pinned Ubuntu 24.04 LTS
   desktop userspace image inside Docker (no slow guest-network package
   install);
3. composes the userspace with the native desktop, Google Chrome 156,
   agent-desktop 1.0.2, the Astreusn wallpaper set, Project Supabase immutable
   bundle/images, SSH/cloud-init configuration and the verified kernel modules;
4. creates a bootable 64 GiB ext4 filesystem from the composed rootfs
   (`mke2fs -d`), converts it to a content-addressed qcow2, and runs
   `qemu-img check`;
5. verifies that Chrome, agent-desktop, the wallpapers, the desktop launcher
   and their licenses are present, then runs the Chrome and agent-desktop
   version checks and publishes the base disk, kernel, initrd and
   `manifest.json`.

Environment:

| Variable | Purpose |
| --- | --- |
| `OPENLINK_UBUNTU_CLOUD_IMAGE_URL` | Override the official kernel source image URL |
| `OPENLINK_UBUNTU_CLOUD_CACHE` | Cloud image cache (default `~/.cache/openlink/ubuntu-cloud`) |
| `OPENLINK_UBUNTU_PROJECT_VM_OUTPUT` | Artifact directory (default `.openlink-runtime/project-vm-base/ubuntu`) |
| `OPENLINK_PROJECT_SUPABASE_CACHE` | Project Supabase bundle/images cache |
| `OPENLINK_PROJECT_SUPABASE_SEED` | Attested Project Supabase image seed copied into the project state before the controller starts (default `.openlink-runtime/project-supabase/cache/seed.json`) |
| `OPENLINK_UBUNTU_USERS_IMAGE` | Pinned Ubuntu desktop userspace image for the base build (default `ubuntu:24.04`; production can use a verified digest) |
| `OPENLINK_MKE2FS_COMMAND` | Host `mke2fs` for the per-project seed disk |
| `OPENLINK_UBUNTU_PROJECT_VM_DISK_GB` | Base virtual size (default 64) |

The artifact is immutable (`0444`). Never edit or boot it directly; projects
boot overlays.

## Start and select the mode

The base artifact includes the immutable Project Supabase bundle and image
archive. On a project VM's first boot, a one-shot systemd unit performs a
local `podman load`; Agent Host waits for its marker before starting the
project Supabase controller. Ordinary startup never pulls these images. The
controller still verifies the loaded image IDs against the release attestation:
Agent Host copies the host-controlled `seed.json` into
`/var/lib/openlink/project-supabase/` before the controller runs, so attestation
rotation does not require rebuilding the base disk. The seed is produced by the
verified E1 golden-image pipeline (`services/agent-host/project-vm-seed-supabase.sh`)
and stored in `.openlink-runtime/project-supabase/cache/seed.json`; it attests
the same image archive that the T1 base embeds.

Agent Host creates a per-project read-only ext4 seed disk with the project
public key and instance-id. The base mounts it at
`/var/lib/cloud/seed/nocloud` before `cloud-init-local.service`, so cloud-init
uses DataSourceNoCloud without SMBIOS or an HTTP seed listener.

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
    seed/               # cloud-init user-data/meta-data/vendor-data
    seed.img            # read-only ext4 volume mounted as /var/lib/cloud/seed/nocloud
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

- `ubuntu-vms/<machine>/` (`disk.qcow2`, `id_ed25519`, `seed.json`, `seed/`,
  `seed.img`, `vm.json`);
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

## Switching architectures

A T1 project runtime is bound to T1. Starting E1 against the same project skips
the automatic restore and fails explicit provisioning with the recorded
architecture in the error; it does not start a second VM or take over T1 ports.

Use the supported one-command workflow after stopping the app:

```bash
npm run runtime:switch -- --project <project-uuid> --to e1
```

The command quiesces T1, exports and verifies the workspace and Project Supabase
state, archives the T1 runtime descriptor, provisions E1, imports the data,
verifies endpoints and rolls back to T1 if any step fails. The T1 disk is
retained, so a later `--to t1` migration can restore/overwrite it with the
current E1 data. See
[Switching architectures](../README.md#switching-architectures) for the data
contract, backup layout and failure semantics. Active chat leases are not
resumed across the switch.

## Failure recovery

| Symptom | Action |
| --- | --- |
| `T1 requires ... /dev/kvm` | Enable host KVM and ensure the process can access it, or use `-e1` |
| `T1 Ubuntu Project VM image manifest is missing` | `pnpm runtime:ubuntu-vm-image` |
| `disk is missing` | Restore the project disk or explicitly recreate the project runtime |
| `host port ... already in use` | Stop the conflicting process. Ports persisted for a running VM are reused even though QEMU itself owns them; a stopped VM reallocates only when a foreign process holds a persisted port |
| `did not become reachable` | Inspect `console.log`; check QEMU started, the seed disk is attached as `/dev/vdb`, and the guest can DHCP |
| Desktop unreachable | `ssh ... systemctl status openlink-desktop`; inspect `/tmp/openlink-*.log` in the guest |
| SSH reset / `ssh.service` failed | Check the seed disk is attached as `/dev/vdb` and `ssh-keygen` path in the base; the service must generate host keys before `sshd -t` |
| Cloud-init failed | The console log and `/var/log/cloud-init-output.log` identify the module; fix the base artifact or the host network |
| `Project Supabase runtime: lifecycle operation ... is already running` after a VM reboot | The lock is boot-id aware; a lock from an earlier guest boot is stale even if its PID was reused. If an older controller still blocks, remove `/var/lib/openlink/project-supabase/.lifecycle.lock` in the guest and rerun provisioning |
| Project services unhealthy | The existing project Supabase/OpenSandbox logs and health probes apply; a stale session container is removed rather than blocking the VM |
| `Project Supabase seed is not readable` | Provide `OPENLINK_PROJECT_SUPABASE_SEED` or export `seed.json` from a verified E1 Project VM; provisioning fails before starting containers |
| Supabase `auth` exits with `lookup db on 10.89.0.1:53 ... i/o timeout` or `network is unreachable` | The base must include `aardvark-dns` and project containers must keep `--dns-search dns.podman`; rebuild the artifact/recreate the project VM if it predates either fix |

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
qemu-img info .openlink-runtime/project-vm-base/ubuntu/ubuntu-project-vm-base-*.qcow2
ls -lh .openlink-runtime/project-vm-base/ubuntu/vmlinuz-* .openlink-runtime/project-vm-base/ubuntu/initrd.img-*
```

Scenario tests should cover: first boot, stop/start, Agent Host restart,
host reboot, QEMU crash, missing disk, port conflict, desktop restart, stale
session workload, and project deletion. Each must leave a recoverable state
and an explicit error/status projection.
