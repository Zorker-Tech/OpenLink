# ADR-0017: Instantiate thin Project VM disks through verified native clones

## Status

Accepted — 2026-08-21

## Context

The Project VM Golden Disk is a 64 GiB logical raw disk with roughly 9–10 GiB
of allocated data. Passing that disk directly to `podman machine init --image`
allows Podman to copy the complete logical byte range. On AppleHV this can
materialize sparse holes, consume tens of GiB per Project, take many minutes,
and exhaust the host volume before the VM starts.

Project creation already declares an immutable `thin` or `thick` allocation
mode. The implementation and every hardware smoke test must exercise the same
disk-instantiation contract; a validation-only byte-copy path is not evidence
that production provisioning is safe.

## Decision

Agent Host remains the authoritative owner of local Project VM disk
instantiation.

The Golden Disk uses a dedicated ext4 `/boot` filesystem and an XFS root/data
filesystem. This keeps the GRUB-readable boot path resilient across repeated
local AppleHV power cycles while retaining XFS for the guest's application and
container data.

For a new Podman/AppleHV machine, Agent Host will:

1. ask Podman to create machine configuration, Ignition, SSH identity and the
   target disk path from a protected 4 KiB placeholder image;
2. keep the machine stopped and validate that the Podman target is a regular,
   protected sparse placeholder distinct from the immutable Golden Disk;
3. create a uniquely named staging disk beside the target using native
   copy-on-write cloning (`clonefile` through BSD `cp -c` on APFS, mandatory
   reflink through GNU `cp --reflink=always` on supported Linux filesystems);
4. verify logical size and host allocation before atomically renaming the
   staging disk over Podman's placeholder disk;
5. start the VM only after the verified replacement is durable.

Thin mode fails closed when the host filesystem cannot provide native CoW. It
never silently falls back to Podman's byte copy or to a full materialization.
Thick mode remains an explicit independent copy with a full logical-capacity
preflight. Disk mode is immutable for the Project.

Hardware validation must instantiate its VM through the production
`PodmanMachineDriver`, assert the thin-clone allocation contract, block image
registries, run the complete Project Supabase smoke, power-cycle the same
registered VM and disk through the production Driver, verify a changed guest
boot ID, and then verify persisted PostgreSQL and Storage fixtures.

## Consequences

### Positive

- New thin Project VMs share immutable Golden Disk blocks and allocate host
  storage only for Project-specific writes.
- Machine configuration remains Podman-compatible without giving Podman the
  real Golden Disk as a custom-image copy source.
- Partial clone failures are never booted and are removed with the incomplete
  Podman machine registration.
- Runtime and hardware validation use one implementation and one failure
  contract.

### Negative

- Thin mode requires APFS, XFS reflink, Btrfs, or another filesystem with a
  working native clone primitive.
- Moving the Golden Disk or Podman data root across filesystems can make thin
  provisioning unavailable until the operator co-locates them or selects
  thick mode with sufficient capacity.
- Host allocation accounting is filesystem-specific and needs a bounded
  tolerance for metadata and first-boot writes.

### Neutral

- The guest-visible disk layout and 64 GiB capacity do not change.
- Project Supabase images, secrets, data ownership and upgrade lifecycle are
  unchanged by the host disk-instantiation mechanism.

## Failure, recovery and rollback

- Invalid Golden Disk metadata, a non-regular target, clone failure, logical
  size mismatch or unexpected thick allocation is terminal for that attempt.
- Agent Host removes the incomplete machine registration and staging disk;
  the immutable Golden Disk is never modified.
- The durable runtime reconciler may retry with bounded backoff after capacity
  or filesystem placement is corrected.
- Existing Project VM disks are not rewritten. Rollback is the previous Agent
  Host implementation and does not require a disk migration.

## Security and operations

- Clone source and target paths are internal lifecycle state, never user input.
- The staging file is mode `0600`, created in the Podman disk directory and
  atomically published before first boot.
- Diagnostics report logical/allocated byte counts and failure category but
  never Project Supabase secrets or SSH private key contents.
- Ordinary startup consumes the published Golden Disk and performs no image
  build, registry pull or upstream acquisition.

## Alternatives considered

### Pass the Golden Disk directly to Podman

Rejected because AppleHV may materialize sparse holes and because Podman's
copy behavior is not the OpenLink thin-disk contract.

### Sparse-copy every new Project disk

Rejected as the default because it duplicates all allocated Golden Disk data
per Project and loses block sharing. It may become a separately governed disk
mode later, but is not a silent fallback for `thin`.

### Maintain Podman machine configuration ourselves

Rejected because it would duplicate Podman's Ignition, SSH, connection and
provider compatibility logic. The placeholder pattern preserves Podman as the
machine-configuration owner while Agent Host owns disk materialization.
