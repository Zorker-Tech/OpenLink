# Production Deployment Profiles Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement independent Core/Standard/Dense deployment profiles and Container/VM Project backends, including Linux KVM guidance, Core knowledge-system omission, persistent configuration, diagnostics, and end-to-end lifecycle verification.

**Architecture:** A pure profile contract owns component and resource defaults, while a separate runtime selector owns Project isolation. Production preflight consumes both contracts. The current VM runtime remains the VM implementation; a host-container adapter implements the same Project lifecycle without granting the Agent Host unrestricted Docker authority. Core filters Knowledge Service and Zero from the runtime plan, independently of the selected Project backend.

**Tech Stack:** Node.js 22 ESM, TypeScript 5.9, Docker Engine/Compose, QEMU/KVM, Apple Hypervisor/vfkit, node:test, systemd/launchd production lifecycle.

**Implementation status (2026-09-03):** Implemented for the sealed single-node
runtime. Automated release, six-combination plan, CLI decision, broker,
packaging and Agent Host suites pass. Physical Linux KVM activation and a real
Docker workload remain target-host qualification gates because they require a
privileged production candidate host and the complete signed image set.

---

### Task 1: Lock the two-dimensional architecture

**Files:**
- Modify: `docs/architecture/ADR-0022-production-deployment-profiles-and-resource-governance.md`
- Modify: `docs/architecture/README.md`

**Steps:**

1. Replace the profile-to-backend mapping with independent `deploymentProfile` and `projectRuntime` axes.
2. State that Core omits Knowledge Service and Zero under both backends.
3. State that Standard/Dense may use Container without becoming Core.
4. Document interactive and non-interactive KVM failure behavior.
5. Run `git diff --check` and validate all relative Markdown links.

### Task 2: Add the versioned deployment profile contract

**Files:**
- Create: `deploy/self-hosted/runtime/deployment-profile.mjs`
- Create: `scripts/test/self-hosted-deployment-profile.test.mjs`
- Modify: `package.json`

**Steps:**

1. Write tests for case-insensitive profile/runtime parsing, invalid values, current defaults, component flags and resource baselines.
2. Run the focused test and verify it fails because the module does not exist.
3. Implement immutable `core/v1`, `standard/v1` and `dense/v1` definitions.
4. Export `resolveDeploymentProfile`, `resolveProjectRuntime`, `profileEnvironment` and runtime capability metadata.
5. Verify Core has `knowledge=false` and `zero=false`; Standard/Dense have both enabled.
6. Add the test to `release:test:self-hosted` and rerun it.

### Task 3: Persist profile and runtime independently

**Files:**
- Modify: `deploy/self-hosted/runtime/configuration.mjs`
- Modify: `deploy/self-hosted/config/openlink.env.example`
- Modify: `deploy/self-hosted/openlinkctl.mjs`
- Modify: `deploy/self-hosted/bootstrap-installer.mjs`
- Modify: `scripts/test/self-hosted-configuration.test.mjs`
- Modify: `scripts/test/openlinkctl.test.mjs`

**Steps:**

1. Add failing tests for `OPENLINK_DEPLOYMENT_PROFILE` and `OPENLINK_PROJECT_RUNTIME` persistence.
2. Verify existing configurations default to Standard + VM.
3. Accept `--profile core|standard|dense` and `--project-runtime container|vm|auto` during configuration/install.
4. Resolve `auto` to a concrete backend before writing configuration.
5. Add a protected configuration updater for an explicit backend change.
6. Ensure profile changes never modify tenant entitlement data.
7. Run configuration and CLI tests.

### Task 4: Make the production plan profile-aware

**Files:**
- Modify: `deploy/self-hosted/runtime/production-runtime.mjs`
- Modify: `scripts/test/self-hosted-runtime.test.mjs`
- Modify: `scripts/test/self-hosted-container-broker.test.mjs`

**Steps:**

1. Add failing plan tests for all profile/backend combinations.
2. Filter Zero images and Compose lifecycle from Core.
3. Filter the Knowledge Service process and its state directory from Core.
4. Keep ZOKERBASE, Web, Agent, Browser and edge services in every profile.
5. Expose desired profile, backend and isolation class to Web and Agent processes.
6. Verify Standard/Dense Container plans still include Knowledge Service and Zero.
7. Run production runtime and broker tests.

### Task 5: Add capability-aware virtualization diagnostics

**Files:**
- Create: `deploy/self-hosted/runtime/virtualization.mjs`
- Create: `scripts/test/self-hosted-virtualization.test.mjs`
- Modify: `deploy/self-hosted/runtime/preflight.mjs`
- Modify: `scripts/test/self-hosted-preflight.test.mjs`
- Modify: `services/agent-remote-release/project-vm.sh`

**Steps:**

1. Write deterministic tests with injected filesystem and command runners.
2. Classify Linux as `ready`, `repairable`, `firmware-disabled`, `nested-unavailable`, `permission-denied` or `unsupported`.
3. Detect CPU virtualization, KVM modules, `/dev/kvm` and effective access.
4. Implement bounded activation of installed KVM modules and service identity access, followed by re-detection.
5. Detect Apple Hypervisor with `kern.hv_support`; never claim it can be installed.
6. Skip virtualization checks for Container while retaining Docker checks.
7. Improve remote Project VM bootstrap diagnostics with the same Linux distinctions.
8. Run virtualization, preflight and remote helper tests.

### Task 6: Implement CLI decision handling

**Files:**
- Create: `deploy/self-hosted/runtime/runtime-selection.mjs`
- Create: `scripts/test/self-hosted-runtime-selection.test.mjs`
- Modify: `deploy/self-hosted/openlinkctl.mjs`
- Modify: `scripts/test/openlinkctl.test.mjs`

**Steps:**

1. Test ready, repairable and unsupported KVM decisions without a TTY.
2. Test interactive choices: activate KVM, retain profile + Container, show help, and exit.
3. Require `--acknowledge-isolation-downgrade=1` for unattended VM-to-Container changes.
4. Persist the selected backend; never change Core/Standard/Dense as a side effect.
5. Print a bundled, version-matched KVM guide path and stable diagnosis code.
6. Run selection and CLI tests using injected prompts and service actions.

### Task 7: Introduce a host-container Project lifecycle adapter

**Files:**
- Create: `services/agent-host/src/project-container.ts`
- Create: `services/agent-host/test/project-container-broker.test.ts`
- Modify: `services/agent-host/src/project-vm.ts`
- Modify: `services/agent-host/src/project-runtime.ts`
- Modify: `services/agent-host/src/main.ts`
- Modify: `services/agent-host/src/project-runtime-status.ts`

**Steps:**

1. Add `docker-container` to the runtime backend contract and expose `container` isolation.
2. Write adapter tests for stable names, scoped workspace paths, argv execution, copy, stop and remove.
3. Extract the service driver's engine-specific operations so Docker and Podman share lifecycle logic without pretending the host is a VM.
4. Preserve all existing Project port-allocation changes in the dirty worktree.
5. Select VM or Container from `OPENLINK_PROJECT_RUNTIME` in Agent Host startup.
6. Reject persisted Projects whose backend differs until an explicit migration exists.
7. Run Agent Host type-check and unit tests.

### Task 8: Preserve Docker privilege separation

**Files:**
- Create: `services/agent-host/src/project-container-broker.ts`
- Create: `services/agent-host/src/project-container-main.ts`
- Create: `services/agent-host/test/project-container-broker.test.ts`
- Create: `deploy/self-hosted/systemd/openlink-project-container-broker.service`
- Modify: `deploy/self-hosted/runtime/production-runtime.mjs`
- Modify: `scripts/test/self-hosted-service-definitions.test.mjs`
- Modify: `scripts/build-self-hosted-release.mjs`

**Steps:**

1. Test a bounded project operation protocol with strict project IDs, operation enums, request limits and peer authorization.
2. Reject arbitrary executables, shell text, paths, Compose files and engine endpoints from clients.
3. Keep the existing aggregate container broker's three-operation contract unchanged.
4. Run the Project broker under its own root service and socket group.
5. Connect the Container adapter to high-level broker operations only.
6. Verify Agent Host receives neither Docker group membership nor direct Docker Socket access.
7. Run broker and service-hardening tests.

### Task 9: Package the Container backend's sealed artifacts

**Files:**
- Modify: `scripts/build-self-hosted-release.mjs`
- Modify: `scripts/test/build-self-hosted-release.test.mjs`
- Modify: `services/agent-host/project-supabase-runtime.mjs`
- Modify: `scripts/test/project-supabase-runtime.test.mjs`

**Steps:**

1. Add failing release inventory tests for the host-container Project runtime controller, configuration, trust policy and architecture-specific image archives.
2. Make the Project Supabase controller accept a sealed engine/root contract while preserving Podman defaults for VM guests.
3. Package only public verification keys; never package release-signing private keys.
4. Load signed Project runtime images through the privileged broker with immutable image-ID verification.
5. Verify host paths remain under the per-Project state root.
6. Run release and Project Supabase tests.

### Task 10: Expose profile and disabled-feature status

**Files:**
- Modify: `app/api/healthz/route.ts`
- Modify: `lib/knowledge-service.server.ts`
- Modify: relevant OpenLink Settings/knowledge navigation components discovered during implementation
- Test: matching app unit tests

**Steps:**

1. Report profile, backend, isolation class and knowledge availability in protected diagnostics.
2. Return a stable feature-disabled response for Core knowledge APIs instead of an upstream connection error.
3. Hide or disable Core knowledge navigation with an explicit explanation.
4. Ensure Settings cannot read or mutate host/global capacity.
5. Run app type-check and focused tests.

### Task 11: Validate transitions and full lifecycle

**Files:**
- Modify: `scripts/test/self-hosted-runtime.test.mjs`
- Modify: `scripts/test/openlinkctl.test.mjs`
- Modify: `package.json`
- Update: `docs/operations/self-hosted-production.md` or the current operator guide

**Steps:**

1. Test all six profile/backend plan combinations.
2. Test Core omits knowledge while Standard/Dense include it.
3. Test VM-ready startup, repairable KVM, unsupported KVM + explicit Container, and unattended fail-closed behavior.
4. Test profile/backend persistence across restart and status reporting.
5. Test stop order and cleanup for both runtime backends.
6. Run `npm run release:test:self-hosted`.
7. Run `npm --prefix services/agent-host test`.
8. Run root type-check/lint commands available in `package.json`.
9. Run `git diff --check` and inspect that unrelated dirty files were not staged.
