# Non-functional requirements

This baseline records system qualities that every feature must preserve. It
uses behavioral requirements where the repository does not yet have measured
service-level objectives. Numeric SLOs must be added from production telemetry,
not invented in design documents.

## Performance and responsiveness

- A ready project chat must warm or resume its Worker without rebuilding the
  Project VM, base disk, or runtime images.
- Project creation may be slow, but it is asynchronous and exposes explicit
  creating/waiting/active/error state. The UI must remain interactive while it
  progresses.
- Streaming chat events render incrementally and preserve event order. A slow
  persistence write must apply backpressure or surface an error rather than
  silently dropping/reordering events.
- Browser actions and previews reuse an existing healthy Browser session where
  identity and capability scope still match.
- Knowledge ingestion runs as a job. Long embedding/index operations do not
  hold a browser request open indefinitely.
- Expensive lists and tenant queries require an index appropriate to their
  access pattern before production-scale use.

## Availability and degradation

- Every supervised service has a readiness/health signal tied to its critical
  dependency.
- Next.js does not report a dependent surface ready when Agent Host, Browser
  Host, Knowledge Service, ZOKERBASE, or Zero has failed its relevant check.
- A Zero outage blocks semantic search/index work but does not erase or make
  inaccessible the authoritative knowledge sources in ZOKERBASE.
- An embedding-provider outage marks the knowledge job failed/retryable with a
  redacted cause; it does not replace the provider with fake embeddings.
- Browser Runtime failure does not corrupt the chat event store or Project VM
  filesystem.
- A root restart preserves durable Local identity/data, Project VM disks,
  `/workspace`, Git history, Zero data, and browser profiles according to their
  retention scope.

## Reliability and consistency

- Ordered chat/session writes use atomic sequence reservation and idempotent
  append behavior.
- Repeated project, Worker, browser, and knowledge provisioning calls are
  idempotent for the same identity key.
- Cross-store workflows declare their order, compensation, and retry behavior.
  ZOKERBASE state cannot claim a projection is ready before Zero has accepted
  and validated it.
- Destructive operations are scoped and resumable. Partial deletion remains a
  visible state until every required projection is removed.
- Schema and artifact upgrades are forward-migrated; runtime code does not
  silently reinterpret incompatible existing state.

## Security and privacy

- Authentication and authorization are enforced server-side at every trust
  boundary and through ZOKERBASE RLS for exposed data.
- Secrets are encrypted at rest where stored, redacted in logs, and never
  exposed through browser bundles or response payloads.
- Project, session, browser, and knowledge operations enforce tenant scope even
  when an internal caller supplies malformed or cross-tenant identifiers.
- Privileged services bind to loopback/private transport by default. Public
  exposure requires an authenticated gateway and explicit origin/domain policy.
- Network egress is explicit, auditable, and revocable.

## Local operation and release independence

- A previously initialized Local installation starts without Cloud identity or
  Cloud data access.
- Ordinary startup does not require an upstream image registry when all product
  artifacts are installed.
- A new Project VM starts its complete Supabase backend while registry DNS and
  registry egress are unavailable. Missing or mismatched local service images
  are terminal Golden Image defects, never a pull/retry fallback.
- Product releases include or can restore all pinned ZOKERBASE, Zero, Project
  VM, Browser, code-server, OpenSandbox, Podman, and Pi artifacts required by
  the declared platform.
- Logical Project VM disk capacity is thin/sparse where supported and does not
  imply immediate allocation of the full capacity on the host.
- The Project VM Golden Disk uses ext4 for its dedicated `/boot` filesystem
  and XFS for root/data. The boot filesystem choice is release-validated
  across a same-disk guest power cycle before publication.
- Thin Project VM creation uses a mandatory native CoW clone and verifies the
  resulting logical size and host allocation before first boot. A clone
  failure or materialized sparse hole is a provisioning failure, not a reason
  to continue with an unbounded byte copy.
- Project Supabase releases lock the annotated upstream self-hosted tag, peeled
  commit, full configuration/runtime hashes and both amd64/arm64 image manifest
  digests. Upgrade bundles are Ed25519-signed, file-manifested, architecture
  specific and imported without runtime network pulls.

## Maintainability

- Product-owned adapters isolate upstream source changes.
- Internal protocols and persisted formats are versioned before incompatible
  changes ship.
- A component can be built and tested at its owning boundary without compiling
  every vendored repository.
- Architecture standards, ADRs, migrations, environment documentation, and
  implementation change together.
- Compatibility aliases and known exceptions include a removal condition; new
  code does not expand legacy naming.

## Observability

At minimum, each lifecycle reports:

- stable resource identity (workspace/project/session/job IDs);
- requested, provisioning, ready, paused/stopped, and error transitions;
- elapsed time for initialization and resume;
- dependency and retry classification without secret values;
- cleanup result and orphan detection.

Future quantitative SLOs should cover at least Web request latency, project
provision duration, warm/resume latency, first streamed event latency, Browser
action latency, knowledge ingest throughput, search latency, and root startup
readiness. The metric definition and measurement point must accompany every
numeric target.
