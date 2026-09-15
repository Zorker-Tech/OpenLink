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
  ├── Knowledge Service (Standard/Dense)   127.0.0.1:43124
  ├── ZOKERBASE Compose stack              loopback-only host ports
  ├── ZOKERBASE Zero (Standard/Dense)      loopback-only 19530/9091
  └── per-Project runtime                  Container or native VM
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

## Deployment profile and Project backend

These are independent choices. The profile controls product components and
default resource sizing; the Project backend controls isolation.

| Profile | Built-in Knowledge/Zero | Host baseline | Default per-Project resources |
| --- | --- | --- | --- |
| Core | Not started (intentional feature reduction) | 4 CPU / 16 GiB / 100 GiB | 2 CPU / 4 GiB / 40 GiB |
| Standard | Started | 8 CPU / 32 GiB / 200 GiB | 4 CPU / 8 GiB / 64 GiB |
| Dense | Started | 16 CPU / 64 GiB / 500 GiB | 2 CPU / 6 GiB / 64 GiB |

All three profiles support `vm` and `container`. Standard/Dense with Container
retain Knowledge and Zero; lack of KVM is never a reason to force the host into
Core. VM is the stronger isolation boundary. Container is the compatibility
backend for hosts without usable hardware virtualization.

## Host prerequisites

- A dedicated production host meeting the selected profile baseline above.
- Docker Engine with Compose v2. Compose must support the `!override` merge tag.
- For VM: macOS arm64 with Apple Hypervisor support, or Linux amd64 with QEMU,
  hardware virtualization enabled and read/write `/dev/kvm` access. Container
  requires no KVM or Apple Hypervisor.
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
  --app-url https://openlink.example.com \
  --profile standard \
  --project-runtime auto
```

The installer creates a non-listening `openlink` supervisor identity plus
separate `openlink-browser`, `openlink-knowledge`, `openlink-agent`,
`openlink-desktop`, `openlink-web`, and `openlink-edge` identities. Only Agent
receives `kvm`; Agent and Desktop share only the protected workspace group.
Exact supplementary-group replacement removes legacy Docker membership. The
aggregate secrets file remains `root:root` mode `0600`, and each child receives
only its service-specific environment. A root-isolated, Unix-socket-only lifecycle
broker accepts only fixed `status`, `start`, and `stop` operations for the
signed Compose plan. Container Project mode adds a separate root broker whose
Unix RPC accepts only validated project lifecycle operations; Agent Host is
not placed in the Docker group and receives no Docker Socket. The installer
fixes secret/state ownership, enables the required broker service(s) and
`openlink.service`, and waits for
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
  --app-url https://openlink.example.com \
  --profile standard \
  --project-runtime auto

# 3. Fail-closed host and bundle validation.
/opt/openlink/current/bin/openlinkctl preflight \
  --config /etc/openlink/openlink.env
```

`configure` creates a non-secret configuration file, a root-only mode-0600
secrets file, an independent mode-0600 backup key, and a reference to the
administrator-owned installed release trust policy. The sealed installer
publishes that public-key policy separately as `release-keys.json`; every native
runtime start re-verifies the active release signature, anti-replay floor,
target platform and complete file inventory before acquiring the lifecycle lock
or starting a container. On Linux the state root
is mode `0711` so distinct service UIDs can traverse to their own mode-0700
subdirectories without listing sibling state. Re-running configuration never
silently rotates a live database password, JWT root or backup key.

On Linux, `auto` checks QEMU, CPU virtualization, KVM modules and `/dev/kvm`
access. If KVM is repairable, the interactive CLI offers to enable it and
links to the bundled `docs/linux-kvm.md`. If the host cannot provide KVM, it
offers Container while retaining the selected profile, the repair guide, or
exit. It does not suggest Core as a KVM workaround. Unattended VM-to-Container selection fails closed unless
`--acknowledge-isolation-downgrade 1` is supplied. A backend change is rejected
while the old backend has persisted Projects; those runtimes must first be
migrated or removed.

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

PostgreSQL, Storage, Zero, browser profiles, workspaces and selected Project
runtime state (VM disks or Container volumes) are
bound into the state root. The source/release tree is never a data volume. The
production Compose overlays replace development port mappings with loopback
bindings. Only the TLS edge may listen publicly.

## Day-two operations

The installed CLI is the only supported service-control interface. Linux uses
the default `/etc/openlink/openlink.env`, so normal operations do not require a
source checkout or repeated path arguments:

```sh
sudo openlinkctl start
sudo openlinkctl status
sudo openlinkctl health
sudo openlinkctl logs --lines 250
sudo openlinkctl restart
sudo openlinkctl stop
```

`status` reconciles the supervisor, aggregate broker, the selected Project
broker when applicable, and the runtime fencing lock; it exits with code 3
unless they agree that the deployment is active. Its JSON includes the profile,
profile revision, Project backend, isolation class and Knowledge/Zero feature
state. `health` performs
a bounded request to `/api/healthz` and requires the release identity returned
by the application to equal the immutable `current` link. `logs` uses fixed,
non-shell `journalctl`/macOS unified-log arguments and caps requests at 5,000
lines. A corrupt or unreadable lifecycle owner record is an error, never
silently treated as a stopped service.

Create a consistent backup while stopped, then restart:

```sh
sudo openlinkctl stop
sudo openlinkctl backup --config /etc/openlink/openlink.env
sudo openlinkctl start
```

## Upgrade and rollback behavior

`openlinkctl upgrade` verifies the candidate with the installed trust root,
stops the native service, makes an encrypted backup, stages without activating,
atomically activates, starts and verifies health. A failed candidate health
gate restores the previous release link and verifies the old service. Unknown
or undeclared state-schema transitions fail before mutation.

An operator-requested binary rollback is also transactional and accepts only an
already-installed, signed, older release that can read the current state schema:

```sh
sudo openlinkctl rollback \
  --release <previous-release-id> \
  --root /opt/openlink \
  --trust /secure-trust/release-keys.json
```

Rollback stops service admission, creates an encrypted pre-rollback backup,
atomically changes `current`, starts, and checks the exact target release. If
the target fails health, it restores and health-checks the release that was
active when the operation began. A trust-root anti-replay floor or incompatible
state schema always wins over a rollback request.

## Not yet a support claim

The repository currently has passing contract/unit tests and real native
installer-mechanism checks. General production support additionally requires a
final full-product bundle, full Linux runtime qualification, clean-root restore
drill, interruption tests, offline restart and security audit. macOS package and
runtime mechanics are tested, but automatic daemon installation is deliberately
not a support claim until the container engine can run without a logged-in GUI
user. See the qualification record; do not infer GA readiness from this runbook
alone.
