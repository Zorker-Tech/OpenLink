# Project VM Supabase Runtime Design

## Purpose and hard boundaries

Every Project VM contains a complete, independent upstream Supabase backend for
the application developed in that VM. It is unrelated to ZOKERBASE: no source,
image, database, key, migration or identity is shared with the OpenLink control
plane.

The release pipeline selects an approved stable Supabase self-hosted release,
locks the upstream tag and peeled commit, packages its official Docker
configuration, resolves every image for the target architecture, and preloads
those images into the Golden Disk's rootful Podman storage. A Project VM is
created entirely offline and fails closed if its local runtime is incomplete.

## Components

| Component | Responsibility |
| --- | --- |
| `project-supabase.lock.json` | Reviewed upstream tag/commit, config hashes, service/image contract and upgrade metadata |
| Upstream sync tool | Discover stable self-hosted releases, acquire exact `docker/` tree, verify and package it |
| Image acquisition tool | Resolve platform manifests, pull by digest, export OCI archives and emit an attestation manifest |
| Golden Disk seeder | Boot staging disk, import archives into target rootful Podman store, verify and publish disk |
| `ProjectSupabaseRuntimeManager` | Project-local secrets, files, network, volumes, containers, health, status and explicit upgrades |
| Runtime verifier | Offline image, config, data-volume, route and revision checks |

## Release flow

```text
discover latest stable self-hosted tag
  -> review/accept lock update
  -> fetch exact upstream docker tree
  -> verify config hashes
  -> resolve target-platform image digests
  -> acquire OCI archives by digest
  -> install bootc OS to staging disk
  -> loop-mount never-booted staging disk in the isolated builder
  -> rootful podman --root=<target graph root> load all locked images
  -> verify IDs/digests + write runtime attestation
  -> unmount and publish Golden Disk
  -> boot published-disk clone with network disabled
  -> run full Supabase smoke suite
```

## Project initialization

The controller first validates `/usr/lib/openlink/project-supabase` metadata
and the rootful local image set. It creates `/var/lib/openlink/supabase` with
mode `0700`, writes atomic root-only secrets/configuration, creates the
project-private network and persistent volumes, then starts services in
dependency order. Initialization is resumable: an interrupted phase is
reconciled from desired state and container labels rather than blindly
restarting stale containers.

Only API Gateway, Studio and database pooler endpoints bind to VM loopback.
Internal services are network-only. Health checks validate PostgreSQL and each
service, followed by gateway route probes for Auth, REST, Realtime, Storage and
Functions. The revision is committed only after all checks succeed.

## Upgrades

Existing VMs never upgrade implicitly when OpenLink ships. An explicit upgrade
checks the upstream `upgrades.json` gates, local image availability, database
major-version requirements and disk capacity. It snapshots PostgreSQL,
Storage, Functions/configuration and the runtime state document before change.
The old image set is retained. A successful validation atomically changes the
observed revision; a failure restores the backup and previous services. If
restore itself fails, the runtime remains stopped in `upgrade_failed` and
reports the backup identity for operator recovery.

## Verification requirements

- Unit tests: lock schema, release selection, digest/platform validation,
  deterministic configuration, secret redaction and lifecycle transitions.
- Integration tests: fake Podman command contract, idempotent restart,
  unhealthy dependency, missing preloaded image, and rollback behavior.
- Artifact test: inspect the Golden Disk through a VM and prove every locked
  image exists without network.
- E2E smoke: initialize a fresh Project VM; create an Auth user, table/RLS row,
  Storage object, Realtime subscription and Edge Function; restart the VM and
  prove persistence; run with registry egress disabled.
