# ADR-0016: Preload an independent Supabase runtime in every Project VM image

## Status

Accepted

## Context

Every OpenLink Project VM must provide a complete application backend for the
software developed inside that VM. This backend is not part of the OpenLink
control plane and has no dependency on ZOKERBASE. ZOKERBASE remains the
OpenLink application data authority; the Project VM backend serves the end
users and business data of one generated application.

The backend must track the upstream Supabase self-hosted release train. Network
access is not reliable enough to pull a multi-image backend when a Project VM
is created. Ordinary Project VM startup is also required to consume prebuilt
artifacts without pulling or rebuilding images.

Supabase self-hosted releases can contain coordinated configuration, image,
database and gateway changes. Updating image tags independently is unsafe. A
release therefore needs one immutable upstream revision and an auditable set of
platform-specific image digests.

## Decision

OpenLink introduces `ProjectSupabaseRuntime`, an independent Project VM service
domain with these boundaries:

1. A release-candidate sync resolves the highest approved stable
   `self-hosted/v*` Supabase tag, records its peeled Git commit, and acquires
   only that revision's official `docker/` self-hosted configuration.
2. Release production resolves every image to an immutable digest for the
   target Linux architecture. The resulting lock and configuration hashes are
   signed/reviewed release inputs. Formal builds reject tags, commits,
   configuration hashes, or image digests that do not match the lock.
3. The complete upstream default stack is packaged: Studio, the default API
   gateway, Auth, PostgREST, Realtime, Storage, imgproxy, Postgres Meta, Edge
   Runtime, PostgreSQL, and Supavisor. Upstream optional overrides such as Logs
   and Analytics remain separately versioned capabilities; they are not
   silently added to the default stack.
4. The Project VM Golden Image production pipeline installs the bootc OS to a
   staging disk, loop-mounts that never-booted disk inside the isolated image
   builder, imports the locked image set directly into the target rootful
   Podman graph root, verifies all image IDs/digests and runtime metadata,
   unmounts it, and only then publishes the disk. A separate throwaway clone is
   booted for validation and is never promoted back to the Golden Image.
   A copied OCI archive that has not been imported into the target disk's
   `/var/lib/containers/storage` is not considered preloaded.
5. Project VM provisioning never pulls or imports Supabase images. It verifies
   the Golden Image's runtime manifest and every required local image before it
   creates project state. Missing or mismatched images are terminal artifact
   failures, not network-retry opportunities.
6. Each Project VM owns one Supabase instance. Its network, secrets,
   PostgreSQL data, Storage data, Functions source/cache, snippets, generated
   configuration and lifecycle state are VM-local and independent from every
   other Project and from the OpenLink control plane.
7. The Project Runtime Controller is the only caller allowed to manage these
   containers. It uses fixed argv-based Podman operations and generated files
   derived from the locked upstream contract. Project code, Agents and browser
   clients never receive the Podman socket or permanent administrative keys.
8. New Project VMs use the Supabase revision embedded in their Golden Image.
   Existing Project VMs retain their recorded revision until an explicit
   upgrade workflow performs preflight checks, backup/snapshot, migration,
   health verification and commit. Failed upgrades preserve a visible failed
   state and restore the previous runtime and data snapshot.

The runtime is named Supabase in Project VM and developer-facing compatibility
surfaces because it is the upstream product. It must not be renamed to or built
from ZOKERBASE.

## Runtime topology

```text
Project VM (one project, one kernel, one rootful Podman store)
├── OpenLink project services
│   ├── OpenSandbox
│   ├── Browser Host
│   └── code-server
└── ProjectSupabaseRuntime
    ├── isolated network
    ├── api-gw (only published HTTP entry point)
    ├── Studio
    ├── Auth
    ├── PostgREST
    ├── Realtime
    ├── Storage + imgproxy
    ├── Postgres Meta
    ├── Edge Runtime
    ├── PostgreSQL data volume
    └── Supavisor (VM-private database entry points)
```

The API gateway, Studio and database ports bind to Project VM loopback. Public
application routing is a later gateway/DNS concern and does not expose raw
Project VM control or database ports.

## Lifecycle and state machine

```text
absent -> initializing -> ready
             |            |
             v            v
           error       upgrading -> ready
                           |
                           v
                    rollback_pending -> ready | upgrade_failed
```

Initialization and upgrades are serialized per Project. Every operation is
idempotent and records the desired revision, observed revision, phase, image
verification, backup identity, timestamps and redacted failure category.
Process existence is not readiness. Readiness requires PostgreSQL plus every
enabled upstream service to pass its dependency-aware health check and requires
the gateway's Auth, REST, Storage, Realtime and Functions routes to respond.

## Security

- Supabase JWT material, database passwords, API keys, pooler secrets and
  encryption keys are generated independently per Project VM.
- Secret files are root-owned mode `0600`, never stored in `/workspace`, Git,
  Golden Images, image archives, control-plane rows or logs.
- The browser receives only the project gateway URL and publishable/anon key.
  Secret/service-role and direct database credentials stay behind a scoped
  server capability.
- Backend containers cannot mount the Podman socket. Only required writable
  paths and capabilities are granted.
- The runtime network does not join another Project VM or the host network.
- Release acquisition verifies Git identity, file hashes, image digests and
  architecture. Floating image tags are never runtime authority.

## Upgrade and rollback

An upgrade is allowed only when the target bundle declares the current
revision as a supported source or includes a reviewed migration gate for each
breaking transition. The controller:

1. rejects concurrent writes to lifecycle configuration;
2. verifies target images and free disk capacity;
3. records PostgreSQL and Storage backups plus current runtime state;
4. stages target configuration and runs upstream preflight/migrations;
5. recreates services in dependency order and validates public routes;
6. atomically commits the observed revision; or
7. stops the failed target, restores data/configuration and starts the previous
   locked image set.

The Golden Image cannot provide rollback images for every historical release.
Existing VMs therefore retain the image set for their committed revision until
the next upgrade has passed and its rollback retention window expires.

## Consequences

### Positive

- New Project VMs start the complete backend without registry access.
- QCOW/raw copy-on-write disks share immutable preloaded layers efficiently.
- The project backend follows upstream Supabase instead of a forked control
  plane implementation.
- Release and runtime identities are reproducible and auditable.

### Negative

- Golden Images become substantially larger and take longer to produce.
- Each active Project VM has a meaningful baseline CPU, memory and disk cost.
- Supabase breaking releases require explicit migration engineering and cannot
  be rolled out as an image-tag change.
- Real Golden Image validation requires hardware virtualization and cannot be
  replaced by a mocked unit test.

## Alternatives considered

### Pull images when a Project VM is created

Rejected because first boot would depend on registry availability and mutable
external state.

### Copy OCI archives into the Golden Image and import them on first boot

Rejected because first boot pays the full import cost and can fail from disk
pressure. It also does not satisfy preloaded Podman storage.

### Copy or reuse ZOKERBASE

Rejected because ZOKERBASE is the customized OpenLink control plane, follows a
different lifecycle and must not define application backend compatibility.

### Run a shared Supabase outside Project VMs

Rejected because it breaks the Project VM data/security boundary and couples
project availability and upgrades.
