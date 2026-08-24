# Project VM Supabase Runtime Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship a complete upstream Supabase runtime preloaded in the Project VM Golden Image and operate one durable, isolated Supabase backend in every Project VM without first-boot network access.

**Architecture:** Release tooling locks one official self-hosted Supabase revision and platform-specific image digests, then seeds those images into the target Golden Disk's rootful Podman storage. An OpenLink-owned Project Supabase manager verifies the sealed artifact and reconciles project-local secrets, storage, networking, service health, upgrades and rollback through fixed argv-based Podman operations.

**Tech Stack:** Node.js ESM release tooling, TypeScript Agent Host, Podman, bootc, raw/QCOW Project VM disks, upstream Supabase self-hosted services, Node test runner.

---

### Task 1: Lock and validate the upstream release contract

**Files:**
- Create: `services/project-supabase/runtime.lock.json`
- Create: `services/project-supabase/README.md`
- Create: `scripts/lib/project-supabase-lock.mjs`
- Create: `scripts/test/project-supabase-lock.test.mjs`

Write schema validation and tests for stable self-hosted tag, peeled commit,
configuration hashes, complete service set, immutable per-platform digests and
upgrade gates. Reject floating tags, missing services, duplicate aliases,
mutable digest entries and unsupported architectures.

### Task 2: Synchronize and package exact upstream configuration

**Files:**
- Create: `scripts/sync-project-supabase.mjs`
- Create: `scripts/test/sync-project-supabase.test.mjs`
- Modify: `package.json`

Discover the highest stable self-hosted semver, resolve annotated tags to the
peeled commit, acquire only `docker/`, hash every runtime file and produce an
atomic generated bundle under `.openlink-runtime/project-supabase`. Formal
release mode must match the reviewed lock and must never silently rewrite it.

### Task 3: Resolve and acquire immutable multi-architecture images

**Files:**
- Create: `scripts/build-project-supabase-images.mjs`
- Create: `scripts/lib/oci-registry.mjs`
- Create: `scripts/test/project-supabase-images.test.mjs`
- Modify: `package.json`

Resolve every locked tag to the target Linux platform manifest, verify digest
and blob sizes, resume content-addressed downloads, produce OCI archives and an
attestation. Never use a tag as runtime identity. Reuse blobs by digest across
services and fail on registry or architecture mismatch.

### Task 4: Seed rootful Podman storage in the Golden Disk

**Files:**
- Modify: `scripts/build-project-vm-base.mjs`
- Modify: `scripts/build-project-vm-disk.mjs`
- Modify: `services/agent-host/project-vm-base.Containerfile`
- Create: `scripts/validate-project-vm-supabase.mjs`
- Test: `scripts/test/project-vm-supabase-seed.test.mjs`

Include only immutable runtime metadata/configuration in the bootc image.
Install to a staging disk, loop-mount that never-booted disk in the isolated
builder, load all archives into its rootful Podman graph root, verify local
image IDs and write the attestation to persistent state, unmount, and publish
the seeded disk. Reuse is allowed
only when both OS and Supabase fingerprints match.

### Task 5: Implement project-local Supabase reconciliation

**Files:**
- Create: `services/agent-host/src/project-supabase-runtime.ts`
- Create: `services/agent-host/test/project-supabase-runtime.test.ts`
- Modify: `services/agent-host/src/project-runtime.ts`
- Modify: `services/agent-host/src/main.ts`
- Modify: `services/agent-host/src/remote-main.ts`

Implement typed desired/observed state, atomic secret generation, fixed service
definitions, project network/volumes, deterministic configuration material,
dependency-ordered start, image/config verification, health probes, restart,
stop and deletion. Containers carry revision/config labels and are recreated
on drift. No Supabase service receives the Podman socket.

### Task 6: Add explicit upgrades, backup and rollback

**Files:**
- Modify: `services/agent-host/src/project-supabase-runtime.ts`
- Modify: `services/agent-host/test/project-supabase-runtime.test.ts`
- Create: `services/agent-host/src/project-supabase-upgrade.ts`
- Create: `services/agent-host/test/project-supabase-upgrade.test.ts`

Gate supported transitions, verify capacity and images, quiesce writes, create
PostgreSQL/Storage/config backups, stage and validate the target, commit the
revision atomically, retain rollback images, and restore on failure. Persist a
visible terminal `upgrade_failed` state if restore cannot complete.

### Task 7: Expose safe project backend capabilities

**Files:**
- Modify: `services/agent-host/src/project-runtime.ts`
- Modify: `services/agent-host/src/contracts.ts`
- Modify: `services/agent-host/src/prompt-http-server.ts`
- Test: `services/agent-host/test/prompt-http-server.test.ts`

Expose only the VM-private/public gateway URL and publishable key through typed,
authorized server contracts. Keep secret/service-role/database credentials and
raw runtime state out of browser and Agent responses.

### Task 8: Verify artifact, E2E and real runtime behavior

**Files:**
- Create: `scripts/e2e-project-supabase.mjs`
- Modify: `DEVELOPMENT.md`
- Modify: `docs/architecture/standards/04-runtime-lifecycle.md`
- Modify: `docs/architecture/standards/05-data-and-security.md`
- Modify: `docs/architecture/standards/07-non-functional-requirements.md`

Run lock/release tests, Agent Host tests and builds, produce the real Golden
Disk, boot a fresh Project VM with registry egress disabled, validate all local
images and services, execute Auth/REST/RLS/Storage/Realtime/Functions checks,
restart and prove persistence, then test a supported upgrade and forced
rollback. Record exact evidence and keep the goal active until every required
path passes.
