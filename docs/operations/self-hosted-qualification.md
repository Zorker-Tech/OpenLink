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
| Full product release bundle | Pending | Pending |
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
