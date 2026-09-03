# Self-hosted native qualification status

## Evidence policy

A platform is supported only after the exact final bundle digest passes the
full matrix on a representative native host. Unit tests, fixture bundles and
installer tests are recorded separately and never upgraded into a full-product
support claim.

## Current evidence (2026-09-03)

| Area | macOS arm64 | Ubuntu 24.04 amd64 |
| --- | --- | --- |
| Signed fixture bundle and complete inventory | Pass | Pass |
| Safe archive extraction and immutable activation | Pass | Pass |
| Bundled Node execution | Pass | Pass |
| Tamper rejection | Pass | Pass |
| No source build during install | Pass | Pass |
| Complete product release directory + independent inventory verification | Pass (qualification release) | Pending |
| Final distributable archive digest | Pending | Pending |
| Bundled Caddy configuration parse + Chromium process launch | Pass | Pending |
| Native service install/start/reboot | Pending | Pending |
| ZOKERBASE + Zero full health | Pending | Pending |
| Real Project VM and browser/knowledge workflow | Pending | Blocked by host firmware virtualization |
| Backup/clean-root restore/upgrade rollback drill | Pending | Pending |
| Offline restart and fault injection | Pending | Pending |

The latest macOS fixture run is
`.openlink-qualification/macos-installer-20260903-3/results.json`. The latest
Linux fixture run copied from the target is
`.openlink-qualification/ubuntu-installer-20260903/results.json`. Generated
qualification records are intentionally ignored by Git because they contain
host-specific evidence rather than product source.

The macOS qualification release
`2026.09.03-macos-qualification.1` contains 15,929 inventoried files and
78,439,812,426 logical bytes, including the real sparse Project VM disk and all
offline image archives. A second process verified its Ed25519 signature and
every file path, type, mode, size and SHA-256 digest in 410,434 ms. The bundled
Caddy 2.11.4 configuration parsed successfully and the bundled Chromium
151.0.7922.34 process launched and rendered a DOM. The release excludes the Go
SDK used by release engineering. This proves the complete directory contract,
not the final compressed archive or running-product support matrix.

Full macOS host preflight passed Docker 29.4.3, AppleHV, clock synchronization
and port availability, then correctly stopped before mutation because the
selected state volume had only 10,278,043,648 bytes free against the 20 GiB
production minimum. The threshold was not lowered for qualification. A full
runtime run requires a clean production-sized volume.

The sealed Caddy binary also passed a live route drill against isolated mock
upstreams: `/` reached Web, `/v1/browser/gateway/*` reached Agent gateway, and
the auth, REST, storage and realtime prefixes reached ZOKERBASE; all six checks
returned the required security header. On Ubuntu 24.04/systemd 255, the hardened
unit parsed successfully apart from the intentionally absent not-yet-installed
executable and scored 4.5 (`OK`) in `systemd-analyze security --offline`.

The authorized Linux target reports AMD Ryzen 5 5600X and `svm`-related CPU
features, but loading `kvm_amd` fails with `SVM not supported by CPU` and
`/dev/kvm` is absent. This normally means AMD SVM is disabled in firmware or is
not exposed consistently by the host environment. Production preflight fails
closed. Full Linux Project VM qualification cannot pass until SVM is enabled
for every CPU and `/dev/kvm` is writable by the OpenLink service identity.

## Required final matrix

1. Build and sign a native release in the corresponding release environment.
2. Import only the bundle, public trust root and package installer to a clean
   host; prove no source/package registry is available.
3. Install the native service, reboot, and verify all critical health gates.
4. Create a real tenant/project, boot its VM, exercise browser, code, database
   and knowledge paths, and verify persistence across power cycle.
5. Verify privileged ports are unreachable remotely and TLS routes expose only
   the intended tenant APIs/gateway.
6. Restart with registry/network loss; crash host processes and containers;
   test disk pressure and stale lifecycle lock reconciliation.
7. Tamper with bundle, manifest, modes and archive paths and verify rejection.
8. Create encrypted backup, corrupt a copy, restore a valid copy to a fresh
   root, and compare authoritative data.
9. Exercise successful upgrade, interruption before/after activation,
   incompatible schema rejection and automatic compatible rollback.
10. Save redacted machine identity, commands, durations, bundle SHA-256 and
    results under one run ID; repeat for the final digest on both platforms.

## Assurance language

The design targets the product's enterprise T0 engineering controls and a
military-style fault/disaster threat model. It is not a claim of military or
government certification. Such a claim requires a named standard, deployment
scope, accredited evaluator and operational evidence outside this repository.
