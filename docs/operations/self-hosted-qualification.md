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
| Final distributable archive digest + cross-host safe extraction | Pass (qualification release) | Pending |
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

The current macOS qualification release
`2026.09.03-macos-qualification.3` contains 15,929 inventoried files and
78,439,820,149 logical bytes, including the real sparse Project VM disk and all
offline image archives. A second process verified its Ed25519 signature and
every file path, type, mode, size and SHA-256 digest in 384,256 ms. All 21 image
entries bind an immutable Docker image ID; tag reuse alone is rejected. The bundled
Caddy 2.11.4 configuration parsed successfully and the bundled Chromium
151.0.7922.34 process launched and rendered a DOM. The release excludes the Go
SDK used by release engineering. This proves the complete directory contract,
not the final compressed archive or running-product support matrix.

Full macOS host preflight passed Docker 29.4.3, AppleHV, clock synchronization
and port availability, then correctly stopped before mutation because the
selected state volume had only 10,278,043,648 bytes free against the then-current
20 GiB gate. Subsequent resource-envelope hardening raised the production gate
to 32 GiB RAM and 200 GiB free space; the earlier evidence therefore cannot
qualify the current contract. A full runtime run requires a clean
production-sized volume.

The sealed Caddy binary also passed a live route drill against isolated mock
upstreams: `/` reached Web, `/v1/browser/gateway/*` reached Agent gateway, and
the auth, REST, storage and realtime prefixes reached ZOKERBASE; all six checks
returned the required security header. Caddy's production admin API is now
disabled. On Ubuntu 24.04/systemd 255, the current main supervisor unit scores
5.0 (`MEDIUM`) and the private-network container broker scores 2.5 (`OK`) in
`systemd-analyze security --offline`. The main score reflects its bounded root
orchestration role and `SETUID`/`SETGID`/`SETPCAP` handoff capabilities; it has
no network listener, while every network-facing child runs under a separate UID.

A macOS qualification-state backup was encrypted, restored into fresh roots,
and compared byte-for-byte for state, config and secrets; restored modes were
0700/0640/0600. On the Ubuntu target, the final privileged hardened runtime set
passed 59/59 native Node 26 tests. This includes safe archive limits, backup
corruption and wrong-key rejection, clean-root restore, lifecycle locking,
dependency ordering, critical-child cleanup, native SEA installation, systemd
installation semantics, upgrade commit/rollback, durable fsync publication,
incompatible schema rejection, fixed service identities, legacy Docker-group
removal, a real root-only aggregate-secret denial check, bounded health/log
handling, native service control and transactional manual rollback. These are native
mechanism results, not a substitute for a running full-stack data restore.

The corresponding macOS delivery suite passes all 58 platform-applicable tests
(with the one privileged Linux identity test skipped), including the SEA
installer running without a source tree or system Node lookup, fresh-activation
rollback, trust-key lifecycle and anti-replay policy, archive input/expansion/
disk-reserve bounds, encrypted recovery, resource envelopes and service-unit
rollback. Both production Compose overlays parse successfully with Docker
Compose 5.1.3 on macOS and 2.40.3 on Ubuntu.

The Linux container lifecycle broker was exercised against the target's real
Docker 29.4.2 daemon: the broker ran with UID 0 and a restricted primary group,
created a group-readable mode-0660 Unix socket, and an unprivileged user received
only the fixed `status` result. SIGINT removed the socket cleanly. The current
systemd units score 2.5 (`OK`) for the broker and 5.0 (`MEDIUM`) for the bounded
root supervisor under Ubuntu systemd 255's offline security analyzer. Seven
fixed accounts were created through the real privileged installer path. The
`openlink-agent` account has only `kvm` and `openlink-workspace` supplementary
access and no Docker membership; `openlink-web` was unable to read the
`root:root` mode-0600 aggregate secret. A real `setpriv` edge launch reported
UID `openlink-edge` and ambient capability mask `0x400`, exactly
`CAP_NET_BIND_SERVICE`.

A standard Codex Security scan of the preceding immutable snapshot reviewed
23/23 scoped deployment files and reported two High and two Medium findings:
shared service-secret identity, retained legacy Docker membership, mutable
Caddy loopback administration, and an unbounded pre-signature manifest read.
The latter three were closed in `786d0dcff8`; per-process kernel identity and
root-only aggregate-secret enforcement were closed in `9c165a3b92` and then
verified by the privileged Ubuntu test above. Remediation scan
`55764364-80c5-443c-b926-7c5824278fe2` then reviewed 23/23 files and all seven
declared trust surfaces at immutable source revision `b4cf90ce95`, reporting no
remaining or new findings. Final source scan
`6da5c879-abda-45c7-8a27-2f783d336f01` reviewed the same 23/23 deployment files
and nine trust surfaces at `a3d4fea43b`, including day-two service control,
bounded health/log retrieval, startup inventory verification and manual
rollback; it also reported zero findings. Neither source scan substitutes for
scanning and qualifying the exact final distributable bundle digest before GA.

The target's production preflight was exercised at each gate. It rejected
155,956,445,184 available bytes against the 200 GiB minimum; with only that gate
relaxed for diagnosis it rejected 33,536,204,800 bytes of RAM against the 32 GiB
minimum; with both capacity gates relaxed it rejected the absent `/dev/kvm`.
These diagnostic overrides did not start or mutate the product.

The final portable macOS qualification archive is 9,570,549,760 bytes with
SHA-256 `c3fa69c65e2eb5c017b755399f190cff9413fbc5bee0c2c546b044fbac1a1a48`.
It was streamed directly to the Ubuntu host, safely extracted there and fully
verified against the independent public key in 343,520 ms. Qualification found
and fixed three real cross-platform archive defects: Apple PAX/xattr metadata,
GNU sparse path rewriting for the 64 GiB Golden Disk, and base-256 size fields
emitted for large regular files. The macOS archiver now
disables xattrs, Apple metadata and sparse detection; the extractor accepts
only positive, bounded base-256 tar numbers and rejects negative/unsafe values.
It also caps cumulative expansion at 192 GiB and metadata records at 16 MiB.

The matching macOS SEA installer is 143,746,432 bytes with SHA-256
`414ab3b99140629990a27cfc01610fd2eebe663d1b284bb4d79659c3adfbfab8`.
It passed ad-hoc code-signature verification and self-test with no system Node
lookup. Re-running an interrupted install reuses only a complete, permission-safe
configuration whose origin and state paths exactly match; it does not rotate
secrets. A changed request fails closed. Developer ID signing and Apple
notarization remain release-process requirements, so this binary is not GA.

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
