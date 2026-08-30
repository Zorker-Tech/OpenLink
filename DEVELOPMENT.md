# OpenLink development standard

This is the mandatory development entry point. Architecture constraints are in
[`ARCHITECTURE.md`](./ARCHITECTURE.md); detailed standards live in
[`docs/architecture/standards/`](./docs/architecture/standards/README.md).

## Before editing

1. Read the relevant architecture standard and accepted ADR.
2. Inspect the current implementation and `git status`; this repository may
   contain unrelated in-progress work that must be preserved.
3. Classify the target as product code, an OpenLink-owned service, vendored
   source, a migration, or generated runtime state.
4. For a boundary/contract change, write or update an ADR before implementation.
5. Define a focused verification path before changing code.

## Supported root workflows

Run product lifecycle commands from the repository root:

```bash
pnpm dev:local          # complete Local stack
pnpm build              # production Web build
pnpm knowledge:test     # Knowledge Service build and tests
pnpm browser:test       # Browser Host tests
pnpm runtime:zero:status
```

`pnpm dev:local` is the normal complete Local start. Do not manually start a
subset and claim the application is ready unless the task explicitly targets
that isolated service.

Artifact production is separate from runtime startup:

```bash
pnpm runtime:vm-image
pnpm runtime:images
pnpm runtime:zokerbase:images
pnpm runtime:zero:images
pnpm runtime:project-supabase:sync
pnpm runtime:project-supabase:images
pnpm runtime:project-supabase:test
```

Ordinary startup must consume those local product artifacts without pulling
upstream images.

Project Supabase release production is intentionally separate from ZOKERBASE:

```bash
# Review/update services/project-supabase/runtime.lock.json only during a
# deliberate upstream release change, then acquire this host architecture.
pnpm runtime:project-supabase:sync
pnpm runtime:project-supabase:images

# A release operator key is generated once and kept outside source control.
pnpm runtime:project-supabase:keygen
OPENLINK_PROJECT_SUPABASE_SIGNING_KEY_FILE=/absolute/private.pem \
  pnpm runtime:project-supabase:upgrade-bundle

# The complete image path: bootc OCI -> never-booted raw disk -> target
# rootful Podman graphroot seeding -> fresh clone validation.
pnpm runtime:vm-image
pnpm runtime:project-supabase:validate-vm
```

Do not run `keygen` to replace a production key implicitly: it refuses to
overwrite an existing private key. Add/retire trusted public keys through a
reviewed `services/project-supabase/release-trust.json` change and retain old
keys for the supported upgrade window. Generated archives, private keys,
Golden Disks and bundles remain under ignored runtime/release directories.

## Editing rules

### Web and BFF

- Keep client components free of server-only code and secrets.
- Browser requests go through authenticated BFF routes.
- Use existing theme tokens and support both light and dark modes.
- Render actual backend/runtime state; placeholder data is allowed only in an
  explicitly isolated fixture or Storybook/test surface.
- Keep timelines and streaming event order faithful to persisted event order.

### Services

- Keep Agent Host, Browser Host, Knowledge Service, and Workers independently
  buildable.
- Validate input at the boundary and return typed, actionable errors.
- Add timeouts, cancellation, health checks, cleanup, and restart behavior for
  every long-running resource.
- Never pass a service token, service-role key, SSH private key, or Zero
  credential to the browser or Project VM.
- Do not execute user-controlled strings through a shell when an argv/API form
  is available.

### ZOKERBASE and migrations

- Put new schema changes in `zorkerbase/migrations/` with a timestamped,
  descriptive filename.
- Treat migrations as append-only once applied. Do not rewrite a historical
  migration to change an existing installation.
- Enable RLS on exposed tables and add the exact workspace/user policies.
- Keep privileged writes behind server services and service-role credentials.
- Test both clean bootstrap and upgrade over representative existing data.
- Local and Cloud schemas use the same contract even though their data is
  isolated.

### Project VM and Git

- `/workspace` is the project root and Git root.
- Runtime metadata belongs under `.openlink/` and is ignored by project Git.
- Initialize Git on first session preparation after the VM is ready.
- Derive change summaries and version previews from Git, not an independent
  counter or fabricated list.
- Never couple session-idle cleanup to Project VM deletion or shutdown.

### Knowledge and embeddings

- Project VMs and clients call Knowledge Service, never Zero directly.
- ZOKERBASE stores sources/metadata/jobs; Zero stores only vector projection.
- Provider + model + dimension define an index identity; a change requires a
  rebuild/new collection.
- A real enabled embedding configuration is required for ingestion/search.
  Deterministic embeddings are test-only and never product readiness.
- Deletion must remove PostgreSQL-owned state and its Zero projection.

### Vendored source

- Do not add nested `.git` directories or submodules.
- Do not run broad formatters across `backend/` or vendored `services/` trees.
- Prefer OpenLink adapters, patches, overlays, and build scripts over modifying
  upstream source.
- When upstream source must change, record the reason and preserve the pinned
  revision/update procedure in `services/source-revisions.json` or
  `backend/UPSTREAM.md`.

### Runtime state and secrets

- Never edit or commit `.openlink-runtime/`, `.openlink-releases/`, `.agent-data/`,
  `.next/`, service `dist/`, generated disks, or local secrets as source.
- Portable, immutable Docker/OCI images are published to the internal GitLab
  Container Registry (or Generic Package Registry). Do not commit image
  archives to Git/LFS, and do not copy mutable container storage, database
  volumes, Podman machine state, or VM raw disks into the repository.
- Publish the locally built container set to the internal GitLab Generic
  Package Registry with `OPENLINK_PACKAGE_TOKEN="$GITLAB_TOKEN" pnpm
  runtime:images:publish`. Set `OPENLINK_IMAGE_PACKAGE_URL` and
  `OPENLINK_IMAGE_PACKAGE_VERSION` for another project/version. The Project VM
  OCI base is uploaded as an OCI layout archive and is not a runnable registry
  container image.
- The cross-platform dependency contract is published as the
  `openlink-dependencies` Generic Package. It contains lockfiles, manifests,
  and product-owned Pi runtime tarballs, but intentionally excludes
  `node_modules` and host-specific native binaries. On Windows, download that
  package if an offline dependency mirror is needed, then run the normal
  frozen-lockfile install for the Windows architecture.
- Never print secret values during diagnostics. Redact tokens, keys, cookies,
  database URLs, and authorization headers.
- `NEXT_PUBLIC_*` is public by definition.

## Code quality

- Prefer small, typed contracts and focused functions over shared mutable
  state.
- Make retries idempotent and distinguish retryable from terminal failures.
- Preserve event ordering and use atomic database operations where concurrency
  can produce duplicates or gaps.
- Use explicit state machines for lifecycle code; process existence is not
  readiness.
- Keep compatibility aliases localized and documented; new code uses current
  product names.
- Avoid unrelated cleanup in a focused change, especially in a dirty worktree.

## Verification standard

Verification is proportional to risk and must include the owning boundary:

| Change | Required checks |
| --- | --- |
| UI/component | focused interaction in both themes, responsive state, browser console, `pnpm build` |
| API/BFF | authorized/unauthorized, validation, dependency failure, success path |
| service | service build/check and tests, health endpoint, start/stop cleanup |
| database | migration apply, representative SQL/API query, RLS denial and allowed access |
| Project VM | create/wait/active, reopen, `/workspace` persistence, Git status, pause/resume |
| browser runtime | native preview and Chromium smoke, session/profile isolation, invalid capability |
| knowledge | no-model rejection plus real-model ingest/search/delete and tenant isolation |
| image/lifecycle | packaged local artifact, offline/`--pull never` start, root health checks |

The root `tsconfig.json` currently has broad includes and the Web build skips
type validation. Until that is corrected, a successful `pnpm build` is not a
substitute for the relevant service's own TypeScript/check command and focused
tests. Do not hide new errors by adding another global ignore.

## Completion checklist

- Requested behavior works through the real user path.
- No unrelated user changes were overwritten.
- No fake data/readiness was introduced.
- Security, Local/Cloud isolation, and lifecycle invariants still hold.
- Relevant builds/tests and health checks passed.
- Schema, contracts, environment variables, and docs were updated together.
- An ADR was added or superseded when the architecture changed.
- The final handoff states what changed, what was verified, and any remaining
  known limitation.
