# ADR-0019: Use native host drivers for macOS and Windows Local runtimes

## Status

Accepted

## Context

OpenLink Local has two different host-runtime responsibilities:

1. the product control plane (ZOKERBASE and Zero), which runs as Linux
   containers through the host's Docker-compatible desktop engine; and
2. durable, per-project Linux virtual machines, which contain `/workspace`,
   OpenSandbox, project services and the independent Project Supabase runtime.

The original implementation was production-quality on Apple silicon macOS but
encoded AppleHV assumptions in shared lifecycle scripts, executable names,
path separators, browser discovery, disk formats and thin-clone logic. Merely
running the application from WSL would hide those defects and would also move
the product lifecycle away from the Windows checkout. Treating a Docker
container as the Project VM would violate the established VM security and
lifecycle boundary.

Windows provides a native Hyper-V Podman Machine provider. Hyper-V uses VHDX
disks and supports differencing disks whose immutable parent can be the
published Golden Disk. That is the Windows equivalent of an APFS native clone:
new Projects receive independent writable disks without materializing every
Golden Disk block.

## Decision

OpenLink keeps one host-native product lifecycle and selects an explicit host
platform contract:

| Host | Control-plane engine | Project VM provider | Golden Disk | Thin instance |
| --- | --- | --- | --- | --- |
| macOS arm64 | Docker Desktop | AppleHV | sparse raw | verified APFS clonefile |
| Windows x64/arm64 | Docker Desktop | Hyper-V | dynamic VHDX | verified Hyper-V differencing VHDX |
| Linux | Docker Engine | QEMU/KVM or owned remote VM | provider-native | mandatory filesystem reflink |

The Windows application runs from the Windows checkout with Windows Node.js,
Docker CLI, Podman remote client and Hyper-V APIs. WSL is not a Project VM
provider and is never an implicit fallback. Docker Desktop may use any backend
supported and selected by Docker Desktop because it is behind the Docker API;
that implementation detail does not change the Project VM boundary.

The following rules are binding:

1. Platform selection is centralized. Product-owned code must not default an
   unknown platform to AppleHV or use POSIX path syntax on Windows.
2. Bundled executable names, command shims and `PATH` composition are resolved
   for the host (`.exe`/`.cmd` and `;` on Windows; POSIX names and `:` on
   macOS/Linux). Commands continue to execute with `shell: false`.
3. Ordinary startup discovers and, when installed, starts Docker Desktop from
   its supported all-users or per-user installation. A missing installation
   or unhealthy engine produces an actionable, typed failure; it is not
   represented as readiness.
4. Podman remote and its required helpers are built or acquired as pinned,
   checksum-verified product artifacts under `.openlink-runtime/toolchain`.
   The user's global Podman configuration is not mutated.
5. Artifact production emits a provider-specific disk from the same bootc OCI
   fingerprint and locked Project Supabase image set. The manifest records the
   host, provider, format, layout and Supabase image manifest hash. A runtime
   rejects a disk for another provider or architecture.
6. On Windows, Agent Host asks Podman Hyper-V to create the machine metadata,
   SSH identity, Ignition transport and a protected dynamic placeholder VHDX.
   While the VM is stopped it replaces that placeholder with a differencing
   VHDX whose parent is the immutable Golden VHDX. It verifies VHD type,
   logical capacity, parent identity and physical allocation before start.
7. Thin provisioning fails closed. Windows never silently copies the full
   VHDX, imports a WSL distribution or starts from an upstream machine image.
   macOS retains its existing AppleHV direct-process and APFS clone behavior.
8. Project Supabase remains complete, locked, preloaded and rootful inside
   every Project VM on both platforms. No service, health requirement,
   isolation rule, persistence behavior or upgrade/rollback behavior is
   removed for Windows.

## Lifecycle and failure behavior

Startup performs preflight checks before product services are reported ready:

- host and CPU architecture are supported;
- Docker CLI, Compose plugin and daemon are available;
- the selected Podman provider is available (Hyper-V service on Windows);
- bundled Podman/helper artifacts match their manifest;
- the Project VM manifest matches host provider, architecture and disk format;
- the immutable Golden Disk exists and passes provider-specific inspection.

Project VM creation is transactional. Failure before first boot removes the
incomplete Podman machine registration and its staged disk but never modifies
the Golden Disk. Existing AppleHV/raw Project VMs and Windows/VHDX Project VMs
are not converted in place. Rollback of application code leaves their provider
metadata and disks untouched; an older runtime may only attach disks whose
manifest contract it understands.

## Security and operations

- Hyper-V cmdlets receive internally resolved absolute paths as parameters;
  user-controlled values are never interpolated into PowerShell source.
- Docker, Podman, SSH and PowerShell commands use argv execution without a
  command shell. Diagnostics redact credentials and report provider state,
  artifact identity and health category only.
- Windows VM disks, toolchain artifacts and non-secret runtime state remain
  under `.openlink-runtime` on the selected NTFS/ReFS data volume. The
  VM-storage tree permits the well-known Hyper-V VM
  virtual-account SID (`S-1-5-83-0`) as well as the interactive owner and
  required system principals. Per-user credentials live separately under
  `%LOCALAPPDATA%\OpenLink\state`, receive a protected user-only Windows ACL,
  and never inherit VM access. macOS keeps the accepted repository-local state
  layout. POSIX modes remain defense in depth where Node exposes them.
- Hyper-V and Docker daemon authority are privileged capabilities. Setup
  documentation must state their prerequisites and access implications.

## Consequences

### Positive

- Windows is a first-class Local host instead of a WSL launch recipe.
- Project VM isolation, offline startup and complete Project Supabase behavior
  remain identical at the product contract level.
- Hyper-V differencing disks preserve thin project creation even on NTFS,
  where generic reflink cloning is unavailable.
- Platform-specific code is reviewable behind explicit drivers and manifests.

### Negative

- Release production must publish both sparse raw and dynamic VHDX Golden
  Disks for each supported CPU architecture.
- Windows requires a supported Hyper-V edition and administrative host setup.
- Hardware verification must run separately on AppleHV and Hyper-V; one
  platform's passing smoke test cannot certify the other.

## Alternatives considered

### Run the Windows application inside WSL

Rejected because it does not provide a native Windows lifecycle, hides path
and process defects, and makes a shared WSL distribution part of the Project
VM authority boundary.

### Use Docker containers as Project VMs

Rejected because containers do not provide the durable Linux VM boundary that
Project services, nested rootful Podman and per-project lifecycle require.

### Copy the Golden Disk for every Windows Project

Rejected as the default because it materializes immutable data, increases
provisioning latency and violates the accepted thin-disk contract.

### Share one Hyper-V VM between all Projects

Rejected because it collapses project kernels, storage, secrets and failure
domains, and is not equivalent to the existing Project VM contract.
