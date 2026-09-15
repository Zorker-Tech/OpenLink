# OpenLink architecture documentation

This directory is the authoritative home for OpenLink architecture.

The documentation is deliberately split into two kinds:

- [`standards/`](./standards/README.md) describes the architecture that current
  code and all future changes must preserve.
- `ADR-*.md` records why a significant decision was made. An accepted ADR is
  binding unless a newer ADR explicitly supersedes it.

The root [`ARCHITECTURE.md`](../../ARCHITECTURE.md) is the short, mandatory
entry point. It does not replace the standards in this directory.

## Source-of-truth order

When documents disagree, use this order:

1. Current accepted ADRs and the current database migrations.
2. Architecture standards in `docs/architecture/standards/`.
3. Root `ARCHITECTURE.md` and `DEVELOPMENT.md` summaries.
4. Implementation plans in `docs/plans/`.
5. Service README files and comments.

Plans describe a route to an implementation and can become stale after the
implementation lands. Standards describe the intended current system. Source
code remains the final evidence of runtime behavior; a mismatch between code
and a standard is a defect that must be resolved deliberately, not silently
documented away.

## Decision records

The current ADR set covers these areas:

- agent service and execution boundaries;
- Browser Runtime surfaces, gateways, and session binding;
- Pi transport and persistence;
- Project VM and remote execution lifecycle;
- Local/Cloud persistence isolation;
- eager project provisioning and session Worker lifecycle;
- the ZOKERBASE/Zero Knowledge architecture.
- the independent upstream Supabase runtime preloaded into every Project VM
  Golden Image ([ADR-0016](./ADR-0016-project-supabase-runtime.md)).
- verified native clone instantiation for thin Project VM disks
  ([ADR-0017](./ADR-0017-project-vm-disk-instantiation.md)).
- the Local-only, scoped virtual-host proxy for a Project VM's upstream
  Supabase Studio ([ADR-0018](./ADR-0018-local-project-studio-proxy.md)).
- native macOS AppleHV and Windows Hyper-V host drivers with equivalent thin
  Project VM semantics
  ([ADR-0019](./ADR-0019-native-host-platform-runtime.md)).
- ZOKERBASE Platform Console as the product-wide platform control plane, with
  single-node production completed before load-balanced multi-node and
  multi-cluster drivers
  ([ADR-0020](./ADR-0020-zokerbase-platform-console.md)).
- sealed, platform-specific self-hosted releases that customers install and
  operate without source builds or runtime registry pulls
  ([ADR-0021](./ADR-0021-sealed-self-hosted-production-distribution.md)).
- Core, Standard and Dense production profiles with explicit container/VM
  isolation and a strict separation between tenant entitlements in OpenLink
  Settings and global capacity in ZOKERBASE Platform Console
  ([ADR-0022](./ADR-0022-production-deployment-profiles-and-resource-governance.md)).

New decisions use the format below and the next unused ADR number:

The proposed Cloud SDK migration is tracked in
[ADR-0023](./ADR-0023-cloud-platform-sdk.md); it is not an accepted replacement for
the existing Local/Cloud identity or runtime contracts.

```text
# ADR-NNNN: Decision title

## Status
Proposed | Accepted | Deprecated | Superseded by ADR-NNNN

## Context
The problem, constraints, and forces.

## Decision
The binding choice.

## Consequences
Positive, negative, and operational effects.

## Alternatives Considered
Options that were evaluated and why they were not selected.
```

Do not renumber an existing ADR. The repository currently contains a historical
number collision around ADR-0014; preserve filenames for link stability and use
the next unused number for new records.
