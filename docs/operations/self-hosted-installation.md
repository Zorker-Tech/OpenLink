# OpenLink single-node self-hosted production installation

## Scope and status

This runbook defines the customer-facing single-node production profile. It is
not the repository development command and never asks a customer to clone the
source tree, run `pnpm`, compile TypeScript, build Next.js, build an image, or
pull a runtime image. Release engineering produces and signs a complete native
bundle before distribution.

The target topology is one protected host running:

```text
TLS edge (only public listener)
  ├── OpenLink standalone Web/BFF          127.0.0.1:3000
  ├── authenticated Agent gateway          127.0.0.1:43121
  └── tenant ZOKERBASE API paths           127.0.0.1:8000

Native service supervisor (systemd/launchd)
  ├── Browser Host                         127.0.0.1:43120
  ├── Agent Host                           127.0.0.1:43121
  ├── Desktop Agent Host                   127.0.0.1:43123
  ├── Knowledge Service                    127.0.0.1:43124
  ├── ZOKERBASE Compose stack              loopback-only host ports
  ├── ZOKERBASE Zero                       loopback-only 19530/9091
  └── isolated per-Project native VMs      AppleHV or QEMU/KVM
```

Single-node means one host failure domain. It provides sealed supply-chain,
integrity, transactional lifecycle and recoverability controls, but it is not
high availability and is not multi-site disaster redundancy.

## Native release contract

Supported candidates are built independently for `darwin-arm64` and
`linux-amd64`. A bundle contains a pinned Node runtime, standalone Web output,
compiled services and production dependencies, product image archives, native
Podman helpers, the matching Project VM Golden Disk, orchestration profiles and
`openlinkctl`. `release.json` covers every shipped file with its mode, size and
SHA-256 digest and is signed with Ed25519.

Installed files use immutable release directories and an atomic `current`
link. Mutable data is kept outside the release:

| Purpose | Linux | macOS |
| --- | --- | --- |
| Releases | `/opt/openlink/releases/<id>` | `/Library/Application Support/OpenLink/releases/<id>` |
| Active link | `/opt/openlink/current` | `/Library/Application Support/OpenLink/current` |
| Configuration | `/etc/openlink` | `/Library/Application Support/OpenLink/config` |
| State | `/var/lib/openlink` | `/Library/Application Support/OpenLink/state` |
| Logs | `/var/log/openlink` | `/Library/Logs/OpenLink` |
| Backups | `/var/backups/openlink` | `/Library/Application Support/OpenLink/backups` |

## Host prerequisites

- A dedicated production host with at least 32 GiB RAM and 200 GiB free space
  beyond the release, database, Golden Disk and backup capacity.
- Docker Engine with Compose v2. Compose must support the `!override` merge tag.
- macOS arm64 with Apple Hypervisor support, or Linux amd64 with hardware
  virtualization enabled in firmware and read/write `/dev/kvm` access.
- A synchronized host clock, stable DNS, and a TLS domain pointing at the edge.
- Separate offline custody for the release trust root and backup key.

The host does not need Node, npm, pnpm, a compiler, Go, Rust, or registry access
at install/start time. The release supplies its own runtime and image archives.

## Installation transaction

The sealed native installer performs signature verification, immutable install,
protected configuration, fail-closed preflight, systemd registration, startup
and readiness verification as one command on Linux. It contains its own runtime
and trust root; the customer supplies only the signed release archive and public
origin. The low-level commands below remain the recovery and audit interface.

```sh
sudo ./openlink-installer \
  --archive /secure-import/openlink-self-hosted-<release>-linux-amd64.tar.gz \
  --app-url https://openlink.example.com
```

The installer creates a non-listening `openlink` supervisor identity plus
separate `openlink-browser`, `openlink-knowledge`, `openlink-agent`,
`openlink-desktop`, `openlink-web`, and `openlink-edge` identities. Only Agent
receives `kvm`; Agent and Desktop share only the protected workspace group.
Exact supplementary-group replacement removes legacy Docker membership. The
aggregate secrets file remains `root:root` mode `0600`, and each child receives
only its service-specific environment. A root-isolated, Unix-socket-only lifecycle
broker accepts only fixed `status`, `start`, and `stop` operations for the
signed Compose plan. The installer fixes secret/state ownership, enables both
`openlink-container-broker.service` and `openlink.service`, and waits for
systemd `Type=notify` readiness. If startup fails it restores the previous unit
files and service state. It never builds or downloads product dependencies.

The installer is authenticated before it is allowed to run as root. Keep the
approved release public key outside the download/import channel, then verify
the detached checksum signature and the installer bytes:

```sh
openssl pkeyutl -verify -pubin \
  -inkey /secure-trust/openlink-release-signing.pub \
  -rawin -in ./openlink-installer.sha256 \
  -sigfile ./openlink-installer.sha256.sig
sha256sum --check ./openlink-installer.sha256
```

Do not run the installer when either command fails. The checksum, detached
signature and public key must not all come from the same mutable mirror. On
macOS this release signature is additive: a supported public distribution also
requires a valid Developer ID signature and Apple notarization.

```sh
# 1. Verify and immutably install a native bundle.
openlinkctl install \
  --archive /secure-import/openlink-self-hosted-<release>-<target>.tar.gz \
  --trust /secure-import/release-keys.json \
  --root /opt/openlink

# 2. Generate protected, non-default credentials outside the release.
/opt/openlink/current/bin/openlinkctl configure \
  --config /etc/openlink/openlink.env \
  --secrets /etc/openlink/secrets.env \
  --state-root /var/lib/openlink \
  --log-root /var/log/openlink \
  --backup-root /var/backups/openlink \
  --app-url https://openlink.example.com

# 3. Fail-closed host and bundle validation.
/opt/openlink/current/bin/openlinkctl preflight \
  --config /etc/openlink/openlink.env
```

`configure` creates a non-secret configuration file, a root-only mode-0600
secrets file, and an independent mode-0600 backup key. On Linux the state root
is mode `0711` so distinct service UIDs can traverse to their own mode-0700
subdirectories without listing sibling state. Re-running configuration never
silently rotates a live database password, JWT root or backup key.

## Runtime and network rules

`openlinkctl run` is invoked only by the native service manager. It acquires an
exclusive lifecycle lock, rejects a live duplicate, removes only a proven stale
lock, validates capacity/clock/virtualization, loads signed local image
archives, starts Compose with `--pull never`, then starts prebuilt host services
in dependency order. Readiness is withheld until every critical health gate
passes. Shutdown reverses the dependency order and gives Agent Host up to 120
seconds to stop Project VMs cleanly.

The Linux supervisor is a non-listening root control process whose bounded job
is preflight, identity/capability assignment, health supervision and signal
forwarding. Network-facing children never run as root. Caddy's mutable admin
API is disabled in production; the edge child alone retains
`CAP_NET_BIND_SERVICE`, while all other child capability sets are empty.

PostgreSQL, Storage, Zero, browser profiles, workspaces and Project VM disks are
bound into the state root. The source/release tree is never a data volume. The
production Compose overlays replace development port mappings with loopback
bindings. Only the TLS edge may listen publicly.

## Upgrade behavior

`openlinkctl upgrade` verifies the candidate with the installed trust root,
stops the native service, makes an encrypted backup, stages without activating,
atomically activates, starts and verifies health. A failed candidate health
gate restores the previous release link and verifies the old service. Unknown
or undeclared state-schema transitions fail before mutation.

## Not yet a support claim

The repository currently has passing contract/unit tests and real native
installer-mechanism checks. General production support additionally requires a
final full-product bundle, full Linux runtime qualification, clean-root restore
drill, interruption tests, offline restart and security audit. macOS package and
runtime mechanics are tested, but automatic daemon installation is deliberately
not a support claim until the container engine can run without a logged-in GUI
user. See the qualification record; do not infer GA readiness from this runbook
alone.
