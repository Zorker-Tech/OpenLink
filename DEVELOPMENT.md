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
pnpm dev:local          # complete Local stack, T1 by default
pnpm dev:local:t1       # explicit T1 (Ubuntu Project VM + native desktop)
pnpm dev:local:t2       # T2 preview (Ubuntu 26.10 + GNOME 51 Wayland)
pnpm dev:local:e1       # E1 (Podman Project VM + per-chat container desktop)
pnpm dev:cloud          # Cloud Web/BFF and VTSLX SDK Host
pnpm build              # production Web build
pnpm knowledge:test     # Knowledge Service build and tests
pnpm browser:test       # Browser Host tests
pnpm runtime:zero:status
```

`pnpm dev:local` is the normal complete Local start. Do not manually start a
subset and claim the application is ready unless the task explicitly targets
that isolated service.

### Project computer modes

T1 is the default and requires a Linux host with QEMU/KVM. Build its immutable
base once on the development machine or in artifact CI:

```bash
pnpm runtime:ubuntu-vm-image
pnpm dev:local
```

T2 is the explicit preview mode. It uses Ubuntu 26.10 with GNOME Shell 51 on
Wayland and a GNOME Remote Desktop RDP-to-VNC bridge. Build its base once:

```bash
pnpm runtime:t2-vm-image
pnpm dev:local:t2
node scripts/openlink.mjs --mode development --profile local --arch t2
```

E1 is the explicit heavier-isolation compatibility mode and keeps the per-chat
container desktop:

```bash
pnpm dev:local:e1
node scripts/openlink.mjs --mode development --profile local --arch e1
```

The mode is also accepted as `-t1`, `-t2`, `-e1`, `--arch t1`, `--arch t2`,
or `--arch e1`. Ordinary startup verifies the selected artifact and fails
closed rather than switching modes silently. Architecture and recovery details:

- [`docs/architecture/architectures/`](./docs/architecture/architectures/README.md)
- [`docs/architecture/ADR-0029-project-computer-t1-e1-modes.md`](./docs/architecture/ADR-0029-project-computer-t1-e1-modes.md)
- [`docs/architecture/ADR-0030-t2-orion-wayland-preview.md`](./docs/architecture/ADR-0030-t2-orion-wayland-preview.md)
- [`docs/architecture/standards/08-release-versioning.md`](./docs/architecture/standards/08-release-versioning.md)

### Electron desktop shell

The desktop shell uses Electron and its own Vite build while loading the same
OpenLink Web/BFF page used by the browser. Product screens and components stay
in the existing application; `desktop/src/renderer` only forwards Electron to
the configured application URL. Start the full local stack first, then run the
desktop shell in a second terminal:

```bash
pnpm --dir desktop install --frozen-lockfile
pnpm dev:local
# In another terminal:
pnpm desktop:dev
```

`OPENLINK_DESKTOP_URL` selects the page to load and defaults to
`http://127.0.0.1:3000`. `pnpm desktop:build` builds the Electron/Vite shell;
the OpenLink application server and its services remain managed by the normal
product lifecycle.

### Native desktop host setup

Local development uses two independent host boundaries. Docker Desktop owns
the ZOKERBASE/Zero Linux container control plane. A native Podman Machine owns
each durable Project VM: AppleHV on Apple-silicon macOS and Hyper-V on Windows.
Docker Desktop's selected internal backend does not change that contract, and
WSL is never used as an implicit Project VM fallback.

Windows requires Windows 11 Pro/Enterprise (or another Hyper-V-capable
edition), firmware virtualization, the Hyper-V feature and Docker Desktop.
Run the following once from an **elevated Windows PowerShell** terminal:

```powershell
Set-Location I:\openlink
.\scripts\prepare-windows-host.ps1
```

This preparation entry point does not require a globally installed `pnpm`.
It discovers `node.exe` from `PATH`, `NVM_SYMLINK`, the standard nvm4w
symlink, or the machine/per-user Node installation, then invokes the same
checked-in JavaScript preparation pipeline. `pnpm runtime:windows:prepare`
remains an equivalent convenience command after dependencies are installed.

The preparation command builds/verifies the pinned Windows Podman client and
helpers, creates Podman's persistent Hyper-V VSock registry entries, adds the
current account to the local Hyper-V Administrators group, and grants the
well-known Hyper-V VM virtual-account SID (`S-1-5-83-0`) access to the
product-owned VM storage tree. Sign out and sign back in afterward so a normal
non-elevated OpenLink process receives the new group token. `pnpm dev:local`
then checks Hyper-V, VSock, group membership, Docker CLI/Compose/engine health,
artifact platform identity, VM-storage ACLs and secret-file ACLs before
reporting readiness. It fails closed with an actionable error if any
prerequisite is absent.

Windows keeps Hyper-V disks, toolchain artifacts and non-secret runtime state
under the checkout's `.openlink-runtime`. Credentials are a separate security
domain under `%LOCALAPPDATA%\OpenLink\state` and receive a protected
current-user-only DACL; POSIX `0600` modes alone are not treated as security on
Windows. This separation also supports workspaces on enterprise volumes that
permit ordinary data writes but reserve DACL changes for administrators.
macOS retains its existing repository-local runtime paths. Golden Disks are
provider-specific: macOS publishes sparse `.raw`
with native APFS clones, while Windows publishes read-only dynamic `.vhdx`
with verified Hyper-V differencing children. Never copy either artifact across
providers or make a Golden VHDX writable.

Moving to another Windows machine does not require reproducing hidden manual
state. Install Node.js and Docker Desktop, run the checked-in preparation
script once, sign out/in, install the frozen workspace dependencies, and
consume or rebuild the provider-specific artifacts. Hyper-V features, group
membership and VSock registration are host capabilities and are intentionally
reconciled per machine; Project data and release artifacts remain explicit
product state rather than implicit WSL state.

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

### Cloud development profile

Copy `.env.cloud.example` to `.env.cloud`, then set both
`OPENLINK_CLOUD_SUPABASE_URL` and `OPENLINK_CLOUD_SUPABASE_PUBLISHABLE_KEY`
to the same `supabase-us` project used by Studio. Keep the `NEXT_PUBLIC_`
Supabase values pointed at that same project. `OPENLINK_CLOUD_OAUTH_CLIENT_ID`
must match the VTSLX client registered for Studio; configure the server-only
OAuth keyring and revocation key when testing those flows. `.env.cloud` is
ignored by Git and is loaded before the lifecycle supervisor starts.

For a trusted LAN browser test over HTTP, set
`OPENLINK_CLOUD_INSECURE_HTTP_ORIGIN` to exactly the same origin as
`OPENLINK_APP_URL` and explicitly enable
`OPENLINK_CLOUD_OAUTH_LOGIN_ENABLED=true`. This exception is accepted only in
development; the OAuth state cookie uses a development-only non-`__Host-`
name because browsers require `Secure` cookies to use that prefix. Production
Cloud OAuth origins must use HTTPS, and login starts are disabled in production
in the current release. The exact opted-in origin is also passed to the VTSLX
SDK's redirect validator; the SDK keeps its normal HTTPS/loopback restriction
for every other origin.

Run `pnpm dev:cloud` for development or `pnpm start:cloud` for the production
Web lifecycle. Cloud mode starts the Web/BFF and a loopback VTSLX SDK Host for
user-scoped Studio Computer requests. It does not initialize local Podman,
Chromium, Agent/Browser hosts, Studio proxy, Project VM, ZOKERBASE, or Zero
services. Configure any remote Agent/Knowledge endpoints in `.env.cloud` when
those features are needed. Cloud startup also blocks missing values from
Next.js's default `.env*` files, so Local settings do not leak into this
profile. To use Local services, stop Cloud mode and
start `pnpm dev:local`; Local-only runtime initialization happens there.
Missing Cloud Supabase configuration fails before the Web process starts; it
never falls back to Local data.

On Linux, Project runtime image archives, Project Supabase artifacts, and
temporary image build inputs use `~/.cache/openlink` by default. Set
`OPENLINK_LOCAL_RUNTIME_CACHE_ROOT` to keep them on another mounted volume.
Linux Docker image builds use the host network by default so build containers
can use the host DNS resolver; set `OPENLINK_IMAGE_BUILD_NETWORK=default` to
use Docker's default build network instead.

If direct GitHub access is restricted, `OPENLINK_SUPABASE_FETCH_REPOSITORY`
may point at a trusted Git transport mirror. This changes transport only: the
official annotated tag object, peeled commit, configuration tree, upgrade
gates, service contract, and compiled runtime specification remain pinned and
are verified before anything is published into `.openlink-runtime`.

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

# The complete image path: bootc OCI -> never-booted provider disk -> target
# rootful Podman graphroot seeding -> fresh native-clone validation.
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
