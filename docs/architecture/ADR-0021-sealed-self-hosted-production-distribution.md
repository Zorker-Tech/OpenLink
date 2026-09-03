# ADR-0021: Distribute sealed self-hosted production releases

## Status

Accepted

## Context

OpenLink's current root lifecycle is a developer workflow. It can install npm
dependencies, compile service TypeScript, build Next.js, build or acquire
container images, and produce Project VM artifacts before starting the product.
That behavior is useful in a source checkout but is not an acceptable
self-hosted production deployment contract.

A self-hosting customer must receive a complete release for a declared host OS
and CPU architecture. Installation, startup, health inspection, backup,
restore, upgrade and rollback must not require source code, pnpm, npm, a
compiler, a Go toolchain, an upstream package registry, or an upstream image
registry. Release production remains an internal CI/release-engineering
responsibility and must never be hidden inside the customer startup path.

The target assurance level is the product's highest enterprise tier (T0), with
disaster-survival properties suitable for isolated and hostile operating
conditions. This describes engineering controls and tests; it is not a claim
of military certification, which requires an external standard, accredited
assessment and deployment-specific operational controls.

## Decision

OpenLink will publish immutable, platform-specific, sealed self-hosted release
bundles. A bundle contains every product-built artifact needed by its target:

- a bundled, pinned Node.js runtime;
- the standalone Next.js server and immutable static assets;
- compiled OpenLink services with production dependencies;
- ZOKERBASE, Zero and Project Runtime image archives;
- the pinned Podman client/helpers and a provider-specific Project VM Golden
  Disk;
- runtime-only lifecycle scripts, configuration schema and service-manager
  definitions;
- a canonical release manifest, file inventory, SHA-256 digests, Ed25519
  signature and the signing-key identifier.

Release bundles are native per `darwin/arm64`, `linux/amd64`, and any later
explicitly supported target. Artifacts from one OS, architecture, VM provider
or disk format are rejected on another target.

### Separation of responsibilities

```text
Internal release environment
  source + frozen locks + pinned upstream inputs
    -> build
    -> test
    -> assemble complete native bundle
    -> canonical manifest + file inventory
    -> sign
    -> publish immutable bundle

Customer production host
  download/import bundle
    -> verify trust root, signature, identity and every file digest
    -> install immutable release directory
    -> atomically activate release
    -> start prebuilt runtime
```

Customer commands must not execute build tools or dependency installation.
They must not pull an image. Network access during installation or upgrade is
limited to acquiring an already sealed bundle from a configured distribution
endpoint; an offline file import is equally supported.

### Installed layout and atomic activation

Mutable data and immutable releases use different roots. The default Linux
layout is `/opt/openlink/releases/<release-id>`, `/opt/openlink/current`,
`/etc/openlink`, `/var/lib/openlink`, `/var/log/openlink`, and
`/var/backups/openlink`. Native macOS packages use equivalent protected roots
under `/Library/Application Support/OpenLink` and `/Library/Logs/OpenLink`.
Tests and non-root evaluation may override each root explicitly.

An install extracts to a staging directory on the destination filesystem,
verifies the complete inventory again, fsyncs every regular file and directory,
renames the
directory to its immutable release identity, and atomically replaces the
`current` symlink. It never overwrites an existing release directory with
different bytes. Activation records the prior release so rollback is an
atomic link change followed by dependency-aware restart and health validation.

Runtime state, database volumes, Project VM disks, workspaces, credentials,
browser profiles and backups are never stored below a release directory.

### Runtime-only lifecycle

`openlinkctl` is the supported customer interface. It uses the bundled runtime
and provides at least:

```text
verify install configure preflight start stop restart status health
logs backup restore upgrade rollback doctor
```

`start` verifies the active manifest, configuration and secret permissions,
acquires a single-host fencing lock, loads only missing product image archives,
starts ZOKERBASE/Zero and prebuilt services in dependency order, and withholds
public readiness until all critical health gates pass. It contains no code path
for `npm install`, `npm ci`, `pnpm install`, `next build`, `tsc`, `go build`,
`docker build`, `podman build`, or upstream acquisition.

The sealed installer publishes its embedded public trust policy to a protected,
administrator-owned path outside the release tree. The service supervisor uses
that independent policy to verify the active signature, target, anti-replay
sequence and every inventory digest before any runtime mutation.

`status` reconciles the native service manager with the runtime fencing lock;
`health` requires the live application to report the immutable active release;
and `logs` uses bounded fixed arguments. Linux lifecycle mutation is root-only.
Manual rollback is limited to a signed, already-installed older release with
an identical state schema, creates an encrypted restore point first, and
self-restores the starting release when the target health gate fails.

Linux production is supervised by systemd. macOS production is supervised by
a system LaunchDaemon. Service definitions invoke the active release's
`openlinkctl run` contract, apply restart bounds, resource/file limits and a
graceful stop timeout, and never embed credentials.

On Linux, network-facing product processes run as distinct fixed Unix accounts:
`openlink-browser`, `openlink-knowledge`, `openlink-agent`,
`openlink-desktop`, `openlink-web`, and `openlink-edge`. The non-listening
supervisor starts as root only to apply those identities and the edge's single
`CAP_NET_BIND_SERVICE` capability through `setpriv`; every other child receives
an empty capability bounding set. Only `openlink-agent` receives KVM access,
and only Agent/Desktop share the mode-0770 workspace group. No application
identity receives Docker group membership or read access to the root-only
aggregate secrets file. Each child receives an explicit environment allowlist.

A separate root-isolated container lifecycle broker reads only the signed,
root-owned runtime plan and exposes a mode-0660 Unix socket. Its complete
protocol is three fixed operations: `status`, `start`, and `stop`; it accepts no
path, image, Compose file, environment, argument, or arbitrary command from a
client. Requests and connections are bounded and lifecycle mutations are
serialized. systemd further restricts the broker to AF_UNIX, a private network
namespace, no capabilities, no device access, no namespace creation, and fixed
CPU, memory, task and writable-path ceilings.

All containers have explicit memory, CPU and PID ceilings and bounded local log
rotation. The native supervisor has an aggregate cgroup envelope. The baseline
single-node profile fails closed below 32 GiB RAM or 200 GiB free state-volume
capacity; deployment owners must raise these values when tenant/project quotas
or retention policy require more capacity.

### Upgrade, rollback and migrations

Upgrade is a transaction with explicit phases: verify, preflight, lock, backup,
stage, stop admission, migrate, activate, start, verify, commit. A failure
before activation leaves the old release active. A failure after activation
attempts the declared compatible rollback. Destructive or non-reversible data
migrations require a forward-recovery release and cannot claim binary rollback
support.

The release manifest declares minimum/maximum compatible schema and state
versions, required free space, supported upgrade predecessors, and whether a
restore point is mandatory. Startup refuses an incompatible release rather
than improvising a migration.

### Backup and disaster survival

Backups are application-consistent, encrypted, checksummed, versioned and
restorable without the original host. A backup manifest identifies the product
release, schema versions, included stores, host platform, encryption key
identifier and file digests. Backup success is not inferred from archive
creation: verification and scheduled restore drills are mandatory.

The protected set includes ZOKERBASE logical/physical data as appropriate,
Storage objects, Zero source-independent projection state when economical,
Project VM/workspace state, required configuration, and encrypted secret
material or documented external-secret references. Zero may be rebuilt from
ZOKERBASE sources; this changes recovery time but not data authority.

T0 deployments require off-host and off-site copies, immutable retention,
separate backup credentials, a documented offline trust root, and recovery
from a clean replacement host. Multi-site active/standby and quorum services
belong to the later multi-node profile. A single host can meet integrity,
recoverability and supply-chain controls but is never advertised as highly
available or disaster-site redundant.

### Security and supply-chain controls

- Release signatures are verified against an installed trust root before any
  executable or migration runs.
- Trust roots authorize only active Ed25519 keys inside their validity windows;
  revoked, retired, expired and not-yet-valid keys are rejected. A monotonic
  release sequence and trust-root floor prevent replay of an older signed
  release.
- The signed manifest covers every shipped regular file, its mode, size and
  digest; unexpected executable files are rejected.
- Private signing keys never enter a release bundle or production host.
- Secrets are generated/imported at install time, stored outside the release,
  permission checked, redacted from output and never accepted through process
  arguments when a protected file or descriptor is available.
- Privileged services bind to loopback/private sockets. The edge proxy is the
  only public listener and enforces TLS, request bounds and authenticated
  gateway routes.
- Runtime processes use dedicated identities and least privilege. The shared
  state root is search-only (`0711`) on Linux; each service state directory is
  owned by its service identity with mode `0700`. Container authority is
  confined to the fixed lifecycle broker; KVM access remains an explicit
  capability of the Project VM service identity.
- Audit logs are append-oriented, time synchronized and exportable to a remote
  collector. Security-relevant failure never falls back to a weaker mode.

### Required verification

Every supported native bundle must pass on a clean representative host:

1. signature, inventory and platform rejection tests;
2. install without source, compilers, npm, pnpm or registries;
3. boot/reboot supervision and full dependency-aware readiness;
4. denial of public access to privileged service ports;
5. persistent data and Project workspace survival across restart;
6. upgrade success, interrupted upgrade, incompatible-upgrade rejection and
   compatible rollback;
7. encrypted backup, corruption detection and restore to a replacement root;
8. registry/network-loss startup after initial installation;
9. process crash, container crash, disk-pressure and dependency-loss behavior;
10. secret-permission, log-redaction and untrusted-bundle rejection tests.

macOS and Linux results are independent. Passing on one platform does not
certify the other. Simulation/unit tests support the native tests but cannot
replace real installation, process, filesystem, container and reboot/recovery
evidence.

## Consequences

### Positive

- Customer production contains no source-build or dependency-install step.
- Releases are reproducible, auditable, offline-installable and reject partial
  or cross-platform artifacts.
- Immutable activation gives upgrades and rollback a small, testable boundary.
- Durable data is independent from application versions and replacement hosts.
- Single-node hardening establishes the same release contract later consumed
  by ZOKERBASE Platform Console and distributed deployment drivers.

### Negative

- Release engineering must build, sign, publish and test every supported OS
  and architecture separately.
- Complete bundles, especially Golden Disks and image archives, are large and
  require delta/distribution optimization later without weakening verification.
- Backup encryption, key custody, restore drills and offline operation add
  substantial operational work.
- A single-node deployment still has host-level downtime despite T0 integrity
  and recovery controls.

## Alternatives considered

### Run `pnpm start` on a customer host

Rejected because it assumes a source checkout and currently performs build or
dependency preparation. It cannot provide an immutable, offline, attestable
production deployment.

### Publish only container image references

Rejected because the product also requires host-native VM/provider artifacts,
offline installation, a trust manifest and lifecycle/backup tooling. Mutable
tags and registry availability are insufficient release contracts.

### Use one cross-platform bundle

Rejected because Node native dependencies, Podman helpers, CPU architecture,
Project VM provider and Golden Disk format differ by target.

### Claim high availability for a hardened single host

Rejected because no backup or restart policy removes the host failure domain.
HA and site disaster tolerance require the later multi-node/multi-site profile.

## References

- [`ADR-0020-zokerbase-platform-console.md`](./ADR-0020-zokerbase-platform-console.md)
- [`standards/03-repository-boundaries.md`](./standards/03-repository-boundaries.md)
- [`standards/04-runtime-lifecycle.md`](./standards/04-runtime-lifecycle.md)
- [`standards/05-data-and-security.md`](./standards/05-data-and-security.md)
- [`standards/07-non-functional-requirements.md`](./standards/07-non-functional-requirements.md)
