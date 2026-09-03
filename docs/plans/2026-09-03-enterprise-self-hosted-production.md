# Enterprise Self-Hosted Production Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship sealed native self-hosted releases that customers install and operate without source builds, compilers, npm, pnpm, or runtime registry pulls.

**Architecture:** Internal release builders produce platform-specific, signed bundles containing the standalone Web server, compiled services, bundled Node runtime, container archives, Podman helpers and a Project VM Golden Disk. A runtime-only `openlinkctl` verifies and atomically installs immutable releases, keeps durable state outside them, and delegates supervision to systemd or launchd.

**Tech Stack:** Node.js ESM, POSIX shell launchers, Ed25519/SHA-256, tar archives, Docker Compose, Podman/AppleHV/QEMU-KVM, systemd, launchd, Node test runner.

---

### Task 1: Freeze the release and installation contracts

**Files:**
- Create: `docs/architecture/ADR-0021-sealed-self-hosted-production-distribution.md`
- Modify: `docs/architecture/README.md`
- Create: `scripts/test/self-hosted-release.test.mjs`
- Create: `scripts/test/openlinkctl.test.mjs`

**Steps:**
1. Write failing tests for canonical manifests, path validation, platform identity, complete inventory verification and immutable install layout.
2. Run `node --test scripts/test/self-hosted-release.test.mjs scripts/test/openlinkctl.test.mjs` and confirm the missing modules fail.
3. Review ADR-0021 against accepted lifecycle, security and native-provider decisions.
4. Run `git diff --check`.

### Task 2: Implement the signed release manifest library

**Files:**
- Create: `scripts/lib/self-hosted-release.mjs`
- Modify: `scripts/test/self-hosted-release.test.mjs`

**Steps:**
1. Implement strict release/platform identifiers and canonical JSON serialization.
2. Implement recursive inventory generation that rejects symlinks, devices, sockets, unsafe modes and path traversal.
3. Implement SHA-256 file verification and Ed25519 manifest signing/verification with a key identifier.
4. Implement target-platform and minimum-contract validation.
5. Run the focused tests and verify tampering, unknown keys and cross-platform bundles fail closed.

### Task 3: Build complete native customer bundles in release environments

**Files:**
- Create: `scripts/build-self-hosted-release.mjs`
- Create: `scripts/test/build-self-hosted-release.test.mjs`
- Modify: `next.config.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

**Steps:**
1. Add fixture-mode failing tests proving missing Web, service, Node, image, toolchain or Golden Disk artifacts abort assembly.
2. Enable Next.js standalone output for release production.
3. Implement staging of the bundled Node runtime, standalone Web assets, compiled service runtimes, runtime orchestration files, image archives, toolchain and native Golden Disk.
4. Rewrite source-checkout absolute archive paths into bundle-relative manifest paths.
5. Generate inventory, sign the canonical manifest and create a platform/version-named archive atomically.
6. Assert the bundle contains no signing private key, source-only dependency graph or mutable runtime state.
7. Run fixture tests, then produce native macOS and Linux release candidates in their release environments.

### Task 4: Implement runtime-only verification and immutable installation

**Files:**
- Create: `deploy/self-hosted/openlinkctl.mjs`
- Create: `deploy/self-hosted/bin/openlinkctl`
- Create: `deploy/self-hosted/config/openlink.env.example`
- Create: `deploy/self-hosted/trust/release-keys.json`
- Modify: `scripts/test/openlinkctl.test.mjs`

**Steps:**
1. Write failing tests for `verify`, wrong-platform rejection, unsafe archive entries, unexpected files, immutable release collisions and atomic `current` activation.
2. Implement `verify` before extraction/execution using an installed trust root.
3. Implement staged installation on the destination filesystem with restrictive modes and atomic rename/symlink activation.
4. Implement configuration initialization through protected files without secrets in argv or logs.
5. Implement `version`, `status`, and machine-readable JSON output.
6. Run tests as an unprivileged user with temporary roots.

### Task 5: Create the prebuilt production supervisor

**Files:**
- Create: `deploy/self-hosted/runtime/supervisor.mjs`
- Create: `deploy/self-hosted/runtime/preflight.mjs`
- Create: `deploy/self-hosted/runtime/health.mjs`
- Create: `scripts/test/self-hosted-supervisor.test.mjs`
- Modify: `scripts/zokerbase.mjs`
- Modify: `scripts/zero.mjs`

**Steps:**
1. Write static and behavioral tests proving the runtime path cannot execute build/install/acquisition commands.
2. Implement artifact, disk, memory, port, engine, Compose, virtualization, clock and permission preflight checks.
3. Load bundled product image archives only when their immutable digest is absent; keep Compose on `--pull never`.
4. Start prebuilt Browser Host, Knowledge Service, Agent Hosts and standalone Next.js with the bundled Node runtime.
5. Add dependency-aware readiness and ordered graceful shutdown.
6. Add an exclusive lifecycle lock and stale-owner reconciliation without starting two supervisors.
7. Run crash, missing-artifact and dependency-failure tests.

### Task 6: Add native service supervision and protected edge profiles

**Files:**
- Create: `deploy/self-hosted/systemd/openlink.service`
- Create: `deploy/self-hosted/systemd/openlink.tmpfiles.conf`
- Create: `deploy/self-hosted/launchd/com.zokerbase.openlink.plist`
- Create: `deploy/self-hosted/edge/Caddyfile`
- Create: `scripts/test/self-hosted-service-definitions.test.mjs`

**Steps:**
1. Write tests for dedicated identities, restart bounds, graceful timeouts, protected paths, loopback bindings and absence of embedded secrets.
2. Add systemd service hardening compatible with Docker/KVM/Project VM requirements.
3. Add a system LaunchDaemon with equivalent lifecycle and protected state paths.
4. Add a TLS edge template exposing only Web/BFF and authenticated gateway routes.
5. Implement `openlinkctl service install|remove|start|stop|status` with explicit privilege checks.
6. Validate definitions with native `systemd-analyze verify` and `plutil -lint`.

### Task 7: Implement backup, restore, upgrade and rollback transactions

**Files:**
- Create: `deploy/self-hosted/runtime/backup.mjs`
- Create: `deploy/self-hosted/runtime/upgrade.mjs`
- Create: `scripts/test/self-hosted-backup.test.mjs`
- Create: `scripts/test/self-hosted-upgrade.test.mjs`

**Steps:**
1. Write failing tests for encrypted backup manifests, corruption detection, incomplete backup rejection and destination-root safety.
2. Implement quiesce/snapshot hooks for ZOKERBASE, Storage, Zero and Project VM/workspace state.
3. Encrypt backup payloads with a key reference supplied through a protected descriptor/file, never argv.
4. Verify every payload digest before reporting backup success.
5. Implement upgrade phases: verify, preflight, lock, backup, stage, migrate, activate, start, verify and commit.
6. Implement compatible rollback and fail closed on irreversible schema boundaries.
7. Restore into a fresh temporary root and compare authoritative data fixtures.

### Task 8: Complete Linux Project VM release parity

**Files:**
- Modify: `scripts/lib/project-vm-artifact.mjs`
- Modify: `scripts/build-project-vm-disk.mjs`
- Modify: `services/agent-host/src/project-vm.ts`
- Modify: `scripts/test/project-vm-artifact.test.mjs`
- Modify: `services/agent-host/test/project-vm.test.ts`

**Steps:**
1. Add failing tests for `linux/amd64`, QEMU, qcow2 and mandatory same-filesystem reflink/CoW identity.
2. Add the Linux native Golden Disk contract and reject incompatible AppleHV/Hyper-V artifacts.
3. Implement transactional Linux disk staging and verified CoW instantiation without thick-copy fallback.
4. Produce an amd64 Golden Disk with the locked Project Supabase image set.
5. Boot a real Project VM, validate all required endpoints and verify persistence across a same-disk power cycle.

### Task 9: Run native macOS and Linux release qualification

**Files:**
- Create: `docs/operations/self-hosted-installation.md`
- Create: `docs/operations/self-hosted-backup-recovery.md`
- Create: `docs/operations/self-hosted-qualification.md`
- Create: `.openlink-qualification/<run-id>/results.json` (generated, ignored)

**Steps:**
1. On macOS arm64, build a release candidate internally, then copy only the sealed bundle and public trust root to a clean install root.
2. Install and start without source-build commands; verify all services, a real project, browser, knowledge dependency health and persistent restart.
3. Exercise signature tampering, offline restart, service crash, backup, clean-root restore, upgrade interruption and rollback.
4. Repeat independently on Ubuntu 24.04 amd64 using the authorized target host.
5. Capture exact host identity, bundle digest, test commands, timings and redacted results.
6. Do not mark a platform supported until its complete qualification record passes.

### Task 10: Security and completion audit

**Files:**
- Modify: `DEVELOPMENT.md`
- Modify: `services/README.md`
- Modify: `docs/architecture/standards/04-runtime-lifecycle.md`
- Modify: `docs/architecture/standards/07-non-functional-requirements.md`

**Steps:**
1. Search the customer runtime path for build, package-manager, upstream-pull and source-checkout dependencies.
2. Verify no credential, private key, local environment or mutable runtime state entered Git or a bundle.
3. Run all release/deployment tests and affected service suites.
4. Re-run native qualification for the final bundle digest on both platforms.
5. Document exact supported platforms, prerequisites, limitations, recovery procedures and evidence.
6. Compare every ADR-0021 requirement with authoritative implementation/test evidence before declaring completion.

