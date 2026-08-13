# Architecture change governance

## When an ADR is required

Create or update an ADR before merging a change that alters any of these:

- a process, trust, or deployment boundary;
- Local/Cloud identity or persistence behavior;
- source-of-truth ownership or a cross-store transaction;
- Project VM, Worker, Browser, or Knowledge lifecycle;
- a public/internal protocol or capability format;
- secret storage, authorization, RLS, or network policy;
- artifact/image production or vendored-source strategy;
- a user-visible product/runtime naming contract.

Small implementation changes that preserve all existing boundaries do not need
an ADR. They still need appropriate tests and documentation updates.

## Change procedure

1. **Inventory the current behavior.** Read relevant accepted ADRs, standards,
   code, migrations, and service contracts. Do not design from memory.
2. **State requirements and invariants.** Include Local and Cloud behavior,
   failure modes, security impact, migration, rollback, and operational cost.
3. **Compare alternatives.** Document at least the current design, the proposed
   design, and a simpler option when one exists.
4. **Record the decision.** Add a proposed ADR and update affected standards.
5. **Implement through owned boundaries.** Prefer adapters/overlays over direct
   upstream-source changes.
6. **Migrate safely.** Make schema/data/artifact transitions resumable and
   backward-compatible for the declared support window.
7. **Verify contracts and end-to-end behavior.** A process starting is not
   sufficient evidence.
8. **Accept or revise the ADR.** Mark the decision Accepted only when the code,
   migration, docs, and verification agree.

## Required design review dimensions

Every architecture review answers:

| Dimension | Required question |
| --- | --- |
| Ownership | Which component is authoritative for each new state? |
| Trust | Which boundary validates identity and authorization? |
| Failure | What happens if each dependency is slow, unavailable, or restarts? |
| Recovery | Can work resume without data corruption or duplicate side effects? |
| Local/Cloud | Are capabilities consistent while identity/data remain isolated? |
| Security | Which new secret, port, URL, or capability is introduced? |
| Operations | Who starts, checks, upgrades, and stops the component? |
| Release | Is runtime construction separated from ordinary startup? |
| Migration | How do existing installations move forward and roll back? |
| Observability | What proves ready, degraded, failed, and recovered states? |

## Verification matrix

Use the smallest relevant set, but do not omit a layer merely because another
layer passed.

| Change area | Minimum verification |
| --- | --- |
| Web/UI | production Web build plus focused browser interaction and console check |
| BFF/API | auth-required, unauthorized, valid, invalid-body, and dependency-failure cases |
| ZOKERBASE schema/RLS | migration apply on existing data, clean bootstrap, policy checks, representative query |
| Agent Host/Worker | service build/check, unit tests, lifecycle test, event ordering/persistence check |
| Project VM | create → waiting → ready, restart/reopen, pause/resume, `/workspace` persistence, Git status |
| Browser Host | service tests, profile concurrency, capability rejection, native preview and Chromium smoke tests |
| Knowledge | Knowledge Service tests, no-model rejection, ingest/search/delete with a real configured model, tenant isolation |
| Runtime images | offline/`--pull never` start from packaged artifacts and checksum/revision validation |
| Root lifecycle | clean start, health checks, coordinated restart, and shutdown without orphaned competing processes |

## Documentation completion criteria

A change is not complete until:

- the root summaries still describe it accurately;
- standards and accepted ADRs do not contradict it;
- environment variables and ports are documented at the owning service;
- migration and rollback behavior is explicit;
- user-visible state does not claim unavailable capabilities;
- obsolete names, compatibility paths, and plans are either removed or marked
  with an owner and removal condition.
