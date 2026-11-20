# ADR-0037 — Project runtime resource reclaim

Status: accepted
Date: 2026-11-19
Related: [ADR-0022](./ADR-0022-production-deployment-profiles-and-resource-governance.md),
[ADR-0029](./ADR-0029-project-computer-t1-e1-modes.md),
[T1 operations](./architectures/t1/operations.md)

## Context

T1 and T2 run one durable Ubuntu desktop VM per Project. The desktop is started
at boot so opening it is instant, and the Project disk is a thin qcow2 overlay
backed by an immutable base. Three properties combined to make long-lived hosts
consume far more disk and CPU than the live workload required:

1. The root drive never advertised virtio-blk discard. Guest deletions (image
   staging tarballs, container layers, browser caches, logs) freed ext4 blocks
   but left the corresponding qcow2 clusters allocated forever.
2. Provisioning copied every runtime image archive to `/var/tmp` inside the VM
   before `podman load`. Even though the tarball was removed afterwards, the
   thin overlay permanently carried its size, once per Project.
3. The native desktop was intentionally resident for instant open, so every
   Project VM paid for a GNOME session even when nobody was viewing it.

The base image also only verified a disk's logical size, so a copy or archive
extraction that materialized a sparse disk as a thick file passed validation.

## Decision

### 1. Reclaim deleted blocks end to end

- QEMU attaches the Project root disk with `discard=unmap`, which makes the
  virtio-blk queue advertise discard support.
- The guest mounts the root filesystem with `discard=async,noatime` and enables
  `fstrim.timer` as a safety net.
- A one-shot `openlink-reclaim.service` runs `fstrim /` on the first boot of a
  new base generation. This shrinks overlays that grew before discard support
  existed without waiting for the weekly timer.
- `detect-zeroes=unmap` is deliberately not enabled: with a backing file a
  zero write must remain an allocated zero cluster, not fall through to base
  image content.

### 2. Never stage image archives on the Project disk

- The machine driver exposes `streamToMachine(name, command, args, source)`.
  The Ubuntu driver implements it by piping a host file into the SSH client's
  stdin.
- `ProjectRuntimeServiceDriver` feeds each local archive to `podman load` over
  stdin. Remote-host archives and drivers without streaming keep the existing
  copy-then-load fallback.
- The guest-side sweep of leftover `openlink-image-*.tar` files remains for
  VMs provisioned by an older release.

### 3. Freeze the Project desktop instead of keeping it hot

- The desktop unit (`openlink-desktop.service`) is frozen with the systemd
  cgroup freezer when no chat in the Project has a live desktop viewer and no
  chat is working. The VM, its containers and agent work keep running.
- The Desktop Gateway tracks viewers across all chats that share the Project
  desktop. A Project-scoped idle timer suspends the desktop after
  `OPENLINK_DESKTOP_IDLE_TTL_MS`; the first new viewer resumes it before the
  gateway proxies the request.
- Resume is a scheduler wake-up, not a GNOME boot: windows, browser tabs and
  the session bus survive. This preserves the instant-open property that made
  the desktop resident in the first place.
- Runtimes without the unit (E1 container desktops, older bases) report
  `unsupported`; their existing per-session lifecycle is unchanged.

### 4. Bound host memory and host floor

- QEMU attaches `virtio-balloon-pci,free-page-reporting=on` so the guest can
  return free pages to the host. The guest memory cap is unchanged.
- `OPENLINK_PROJECT_VM_FREE_PAGE_REPORTING=0` disables the device for a QEMU
  build that predates the property.
- The `lite` deployment profile targets an 8 GiB / 4 vCPU host with one active
  Project (2 vCPU / 4 GiB / 32 GB).
- `OPENLINK_PROJECT_RUNTIME_EAGER=0` disables eager provisioning. A Project
  then boots the first time a chat opens it; the on-demand `ensure()` path and
  every capability are unchanged.

## Consequences

- A deleted multi-gigabyte archive or container layer now returns its clusters
  to the host instead of growing the overlay permanently.
- Provisioning no longer writes the archive bytes to the Project disk at all;
  the engine still stores the layers it needs.
- An idle Project desktop costs no CPU and resumes in milliseconds. It still
  holds its anonymous memory; hosts that need the memory back should combine
  this with free page reporting, a smaller memory cap, or zram.
- Full VM hibernate (`savevm`/migrate-to-file) is intentionally not used: a
  12 GiB guest writes and reads gigabytes per cycle, resumes in seconds, and
  grows the disk it was meant to protect.
- Existing overlays are compacted on the first boot after the base change. The
  base artifact must be rebuilt to pick up the fstab, timer and unit.
- Remote SSH Project VMs inherit the same behavior through the remote machine
  driver's `runInMachine`.
- A shared read-only container image store in the base and whole-VM pause are
  left as follow-up work; both need a larger change to the image build and the
  runtime health model.

## Verification

Inside a Project VM:

```bash
cat /sys/block/vda/queue/discard_max_bytes   # non-zero
fstrim -v /
systemctl show -p ActiveState,FreezerState openlink-desktop.service
systemctl freeze openlink-desktop.service
systemctl unfreeze openlink-desktop.service
```

On the host:

```bash
qemu-img info --output=json disk.qcow2 | jq '{virtual:."virtual-size",actual:."actual-size"}'
```

`actual-size` must fall after a large file is removed and `fstrim` runs, while
`virtual-size` stays at the Project capacity.
