# ADR-0029: One Project computer with two explicit runtime architectures (T1 default, E1 optional)

## Status

Accepted — 2026-10-31.

This ADR supersedes the placement decision in
[ADR-0026](./ADR-0026-opensandbox-desktop-session-surface.md) for the default
product architecture. ADR-0026 remains authoritative for E1 and for the
retained experimental ISO desktop surface.

## Context

OpenLink has one durable VM per project. Chat sessions are OpenSandbox
workloads inside that VM. Until now the desktop lived inside each session:
either a GNOME/Xfce container desktop (`ubuntu-container`) or a full Ubuntu
Desktop guest inside QEMU/KVM (`ubuntu-iso`).

Production evidence showed that the per-session nested VM is not a supportable
product capability:

- it requires reliable nested virtualization; on a WSL2-hosted Linux
  environment the inner guest soft-locked and never found the casper live
  medium, while the same ISO booted normally on the host KVM;
- every chat paid a full OS install, several GiB of RAM and tens of GiB of
  qcow2, multiplied by the number of chats;
- there is no enterprise story for per-chat OS patching, backup, snapshot,
  audit or quota;
- the Project VM is already the isolation boundary, so a second hypervisor
  adds failure modes without adding a cross-project boundary.

At the same time, the per-session container desktop is reliable and fast, but
it is a session-scoped GUI with no persistent project computer and no
Ubuntu kernel.

The product requirement is a persistent project computer: one workspace per
project, shared by the user and all agent sessions, with a native Ubuntu
desktop and ordinary Linux tooling. That is the standard enterprise cloud
workstation model.

## Decision

### 1. One project owns one durable Project VM and one project-scoped desktop

For T1, the Project VM is an Ubuntu guest composed from the pinned OpenLink
Ubuntu userspace image and the verified Ubuntu 24.04 LTS generic kernel, with:

- a native desktop (GNOME with Xfce fallback) exposed through noVNC/websockify;
- rootful Podman for project services and OpenSandbox session workloads;
- SSH, systemd, Node.js and Git for the existing Agent Host service contracts;
- `/workspace` as the durable project root.

Chats do not own an OS. A chat is an OpenSandbox session inside the project
computer. It still owns its process, filesystem and network isolation.

The desktop is a **project-level resource**. The same endpoint is returned to
every chat; an idle chat must never suspend the project desktop. Per-chat GUI
isolation, when required, is a display-layer concern (for example a per-chat
Xvfb display), not a second kernel.

### 2. Two explicit startup architectures

| Mode | Project VM | Session | Desktop | Selection |
| --- | --- | --- | --- | --- |
| **T1** (default) | Ubuntu Project VM (pinned userspace + LTS generic kernel), native desktop, rootful Podman | OpenSandbox | Project-scoped native desktop | `pnpm dev:local` / `-t1` / `--arch=t1` |
| **E1** (optional) | Existing Podman machine OS, rootful Podman | OpenSandbox | Per-chat container desktop (Xfvb + GNOME/Xfce) | `-e1` / `--arch=e1` |

- T1 replaces E1 as the default in development and production startup.
- E1 remains a supported, explicitly selected architecture. It is the
  heavier-isolation mode: each chat gets its own desktop process, at the cost
  of per-chat GUI resources. It does **not** start the ISO desktop.
- The ISO desktop code path is retained but is not selected by either
  architecture. It is an experimental surface for hosts with verified nested
  virtualization and must never be the product default.
- Startup orchestration accepts the mode through `scripts/openlink.mjs`:
  `-e1`, `-t1`, `--arch e1|t1`, or `OPENLINK_ARCHITECTURE`.

### 3. T1 artifact and trust boundaries

- The Ubuntu base is an immutable, versioned qcow2 artifact plus the verified
  Ubuntu LTS generic kernel/initrd. It is composed once from the pinned Ubuntu
  userspace image: rootful Podman, SSH, cloud-init, the native desktop, the
  project service runtime dependencies and the immutable Project Supabase
  bundle/images. It contains no build SSH key, no cloud-init instance state,
  no machine-id and no SSH host keys.
- Each project gets a qcow2 overlay whose backing file is the versioned base.
  Existing projects keep their recorded base path across base upgrades; a
  missing base or disk fails closed and requires an explicit restore or
  recreate.
- Each project gets its own ed25519 SSH identity, stored under the project VM
  state directory with mode 0600. No SSH identity is shared between projects.
- cloud-init receives per-project identity through a per-project read-only
  ext4 seed disk. The disk contains only the project public key and instance
  metadata and is mounted at `/var/lib/cloud/seed/nocloud` before
  `cloud-init-local.service`; the private key never leaves the Agent Host state
  directory. No HTTP seed listener is required at runtime.
- QEMU host-forwarded service ports, SSH and the desktop are bound to
  `127.0.0.1`. Browsers reach the desktop only through the existing
  authenticated Desktop Gateway. Session workloads remain isolated by
  OpenSandbox inside the VM.
- The base build runs on a Linux host with KVM and uses the host QEMU. It does
  not require xorriso, genisoimage or Docker at runtime.
- T1 currently supports Linux hosts with QEMU/KVM. A Linux host provided by
  WSL2 uses a native QEMU Project VM; WSL itself is not the Project VM. macOS
  AppleHV and Windows Hyper-V native T1 drivers are future work; E1 remains the
  supported mode on those hosts until then.

### 4. Lifecycle and disaster recovery

- A project VM is created once and is durable. `ensureMachine` is idempotent:
  it adopts a running QEMU process, restarts a stopped one from the same disk,
  and never silently creates a new disk once durable state exists.
- The per-project disk, SSH identity, seed identity and runtime secrets are
  the recovery unit. They must be included in project backup and restore.
- Crash recovery:
  - QEMU crash: the next ensure starts the same disk and waits for SSH;
  - Agent Host restart: the persisted runtime descriptor is reattached after a
    bounded health probe; the VM is not re-provisioned;
  - host reboot: the VM is restarted on demand by the persisted runtime sweep;
  - missing disk: fail closed with an actionable error, never silently
    reprovision;
  - stale session container or port conflict: remove that session workload,
    keep the project services and VM activation available;
  - desktop failure: the systemd unit restarts the native session; the Desktop
    Gateway remains the single browser entry point.
- Project deletion removes the VM, its overlays, its SSH identity and the
  project runtime state. The immutable base is shared and never deleted by a
  project deletion.

### 5. Resource and isolation contract

- T1 resources are per project, not per chat: CPU, memory and disk are bounded
  by the Project VM machine spec. Chats share the VM and are bounded by
  OpenSandbox cgroups.
- E1 remains the higher-isolation/lower-density mode: per-chat containers and
  per-chat desktop processes. Organizations choose it explicitly when per-chat
  GUI isolation is more important than density.
- The T1 default memory for local development is 12 GiB (`OPENLINK_PROJECT_VM_MEMORY_MB`),
  because the native desktop, Podman and the project Supabase stack share one
  guest. Production profiles set the value through the existing resource
  governance contract.
- The project desktop is not suspended by chat idle timers. VM idle lifecycle
  belongs to the project runtime, not to a chat session.

## Consequences

### Positive

- One Ubuntu computer per project, shared by the user and every agent, with
  persistent windows, browser state, files and installed tools.
- No nested virtualization in the product path; reliable on Linux KVM.
- One OS to patch, snapshot, back up, audit and quota per project.
- The existing Agent Host, OpenSandbox, Browser Host, code-server and Desktop
  Gateway contracts remain usable.
- E1 preserves the previous isolation model without forcing the nested ISO
  path.

### Negative

- T1 requires a Linux host with QEMU/KVM in this release; macOS and Windows
  need native drivers or must use E1.
- The project desktop is shared across chats; per-chat GUI state is no longer
  isolated by default.
- A T1 Project VM is larger than the minimal Podman machine OS and needs more
  memory for the desktop.
- Switching an existing E1 project to T1 does not silently migrate the old
  project workspace; the old E1 runtime remains a separate durable environment.
  A workspace migration tool is future work.

### Neutral

- The ISO desktop code and golden overlay remain for explicit experimental
  use; they are not the default and not a support commitment.
- The project runtime descriptor gains a project-level `desktopEndpoint` and a
  reserved desktop port. E1 allocates the port but does not use the endpoint.

## Migration and rollback

- A project runtime descriptor is single-owner. Starting the other architecture
  against the same project skips the automatic restore and fails explicit
  provisioning with the recorded architecture in the error; it never runs two
  VMs, overwrites the other descriptor or steals its ports.
- Existing E1 projects remain runnable with `-e1`. No disk migration is
  required while the project stays on E1.
- Moving a project between modes is an explicit, recoverable data migration
  performed by `npm run runtime:switch -- --project <uuid> --to t1|e1`. The
  command stops the app, quiesces the source, exports/verifies the workspace and
  Project Supabase state, archives the source runtime descriptor, provisions the
  target, imports and verifies the data, and retains a backup plus the source VM
  disk. On failure it restores the source runtime and restarts it.
- Active chat leases are not resumed across a switch; sessions are quiesced and
  the workspace `.openlink` state remains. The source VM disk is retained for
  rollback and repeat migration; it is not deleted or converted.
- Rollback is the same command in the other direction, or restoring the archived
  source runtime descriptor and VM. The immutable Ubuntu base and E1 base are
  versioned and retained.
- Base upgrades publish a new versioned qcow2. New projects use it; existing
  projects keep their recorded backing path and are not rewritten.

## Security and operations

- The base artifact is built from a verified official cloud image with a
  pinned SHA-256 manifest. Build credentials are removed before publication.
- The build and runtime never expose the project SSH private key to the guest,
  browser, session workload or logs.
- QEMU uses no host devices beyond KVM; the Project VM remains the hard host
  boundary.
- Startup must fail closed on missing artifacts, missing disks, port
  conflicts, KVM unavailability, cloud-init/SSH timeout and unhealthy
  services, with an actionable error and without silent data substitution.
- Operators must include the project VM state directory in backup/restore and
  exclude the immutable shared base from per-project backups.

## References

- `docs/architecture/architectures/README.md`
- `docs/architecture/architectures/t1/README.md`
- `docs/architecture/architectures/e1/README.md`
- `docs/architecture/ADR-0007-project-vm-runtime-boundaries.md`
- `docs/architecture/ADR-0017-project-vm-disk-instantiation.md`
- `docs/architecture/ADR-0026-opensandbox-desktop-session-surface.md`
- `docs/plans/2026-10-31-runtime-warm-start-architecture.md`
