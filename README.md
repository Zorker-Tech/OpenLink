# OpenLink

OpenLink is a project-scoped AI workspace: one durable Project VM per project,
OpenSandbox chat sessions inside it, and a desktop surface for the user and the
agents to share.

## Architecture modes

OpenLink ships three explicit project-computer architectures. **T1 is the stable default.**
**T2 is the Wayland preview.**

| Mode | Project VM | Session | Desktop | Startup |
| --- | --- | --- | --- | --- |
| **T1** (default) | Ubuntu 24.04 LTS Project VM (GNOME 46 X11 + LTS generic kernel), rootful Podman | OpenSandbox | One native Ubuntu project desktop, shared by all chats | `pnpm dev:local` |
| **T2** (preview) | Ubuntu 26.10 Project VM (GNOME 51 Wayland + RDP bridge), rootful Podman | OpenSandbox | One native GNOME 51 Wayland desktop, shared by all chats | `pnpm dev:local:t2` |
| **E1** (optional) | Podman machine OS, rootful Podman | OpenSandbox | Per-chat container desktop (Xvfb + GNOME/Xfce) | `pnpm dev:local:e1` |

- T1 is the enterprise target: one Ubuntu computer per project, one OS to
  patch/backup/snapshot/quota, no nested virtualization, persistent desktop
  state shared by the user and every agent.
- T2 is the preview channel: latest Ubuntu and GNOME Wayland, with the same
  one-project-one-VM model and a GNOME Remote Desktop RDP-to-VNC bridge.
- E1 remains supported for hosts that need the previous heavier per-chat
  isolation, or that do not yet have a native T1 driver. It never starts the
  Ubuntu ISO desktop.
- The nested ISO desktop is retained as an experimental legacy surface only.

The binding decisions are
[ADR-0029](./docs/architecture/ADR-0029-project-computer-t1-e1-modes.md) for
T1/E1 and [ADR-0030](./docs/architecture/ADR-0030-t2-orion-wayland-preview.md)
for the T2 preview. Per-mode architecture and operations live in
[`docs/architecture/architectures/`](./docs/architecture/architectures/README.md).

## Release channels

The product version is shared. The current release identity is:

| Channel | Architecture | Release |
| --- | --- | --- |
| stable | T1 | `T1-Crab-0.0.1` |
| preview | T2 | `T2-Orion-0.0.1` |
| compatibility | E1 | `E1-0.0.1` |

The format is `<architecture>-<codename>-<semver>`; see
[release versioning](./docs/architecture/standards/08-release-versioning.md).

## Start here

### T1 (default)

Prerequisites: Linux with `/dev/kvm`, QEMU, OpenSSH, Node.js 22.19+, and Docker
for ZOKERBASE/runtime image archives. The Project Supabase attestation
(`.openlink-runtime/project-supabase/cache/seed.json`) comes from the verified
E1 image build; startup fails closed if it is missing.

```bash
# One-time immutable Ubuntu Project VM base artifact
pnpm runtime:ubuntu-vm-image

# Start the complete Local stack (T1)
pnpm dev:local
```

If the base artifact is missing, startup fails with an actionable error; it
never silently downloads or installs a desktop at runtime.

### E1

```bash
pnpm dev:local:e1
# or
node scripts/openlink.mjs --mode development --profile local --arch e1
```

### Local endpoints

| Service | URL |
| --- | --- |
| Web/BFF | `http://127.0.0.1:3000` |
| Browser Host | `http://127.0.0.1:43120` |
| Agent Host | `http://127.0.0.1:43121` |
| Desktop Agent Host | `http://127.0.0.1:43123` |
| Knowledge Service | `http://127.0.0.1:43124` |
| Desktop Gateway proxy | `http://127.0.0.1:43125` |

## How the modes are selected

`scripts/openlink.mjs` resolves the mode before importing the supervisor:

```bash
pnpm dev:local              # T1 (default)
pnpm dev:local:t1           # T1 explicit
pnpm dev:local:t2           # T2 preview
pnpm dev:local:e1           # E1
pnpm start:t1               # production T1
pnpm start:t2               # production T2 preview
pnpm start:e1               # production E1
node scripts/openlink.mjs --mode development --profile local --arch e1
```

The resolved mode is exported as `OPENLINK_ARCHITECTURE`; the supervisor then
sets the Project VM driver, base artifact, guest user and desktop scope. The
Web/BFF has one code path for both modes.

## Switch an existing project between T1, T2 and E1

Switch is a maintenance operation; stop the app first. It migrates the complete
project workspace and Project Supabase state, verifies every archive, retains a
backup and the source VM disk, and rolls back to the source if any step fails:

```bash
npm run runtime:switch -- --project <project-uuid> --to t2
npm run runtime:switch -- --project <project-uuid> --to t1
npm run runtime:switch -- --project <project-uuid> --to e1
npm run runtime:switch -- --project <project-uuid> --from t2 --to t1 --dry-run
```

Active chat leases are quiesced, not resumed. See
[Switching architectures](./docs/architecture/architectures/README.md#switching-architectures)
for the data and recovery contract.

## Repository map

- `app/`, `components/`, `lib/`, `utils/` — Web/BFF and product UI.
- `desktop/` — thin Electron shell; it loads the same Web/BFF.
- `services/agent-host/` — Project VM lifecycle, Agent Host, OpenSandbox,
  Browser/Desktop gateways.
- `services/agent-worker/`, `services/agent-rpc-worker/` — session workers.
- `services/browser-host/`, `services/knowledge-service/` — owned services.
- `services/pi`, `opensandbox`, `sandbox-runtime`, `code-server`, `linux`,
  `zero`, `backend/` — vendored runtime sources.
- `scripts/` — lifecycle, artifact production and validation entry points.
- `docs/architecture/` — standards, ADRs, per-architecture directories.
- `.openlink-runtime/` — generated runtime state and artifacts; never commit.

## Artifacts

- T1 Ubuntu base: `pnpm runtime:ubuntu-vm-image` →
  `.openlink-runtime/project-vm-base/ubuntu/` (content-addressed qcow2 +
  manifest).
- T2 preview base: `pnpm runtime:t2-vm-image` →
  `.openlink-runtime/project-vm-base/t2/` (Ubuntu 26.10 + GNOME 51 Wayland,
  content-addressed qcow2 + manifest).
- E1 Project VM base/disk: `pnpm runtime:vm-image`.
- Runtime image archives: `pnpm runtime:images`.
- ZOKERBASE and Zero images: `pnpm runtime:zokerbase:images`,
  `pnpm runtime:zero:images`.

Artifact production is separate from ordinary startup. Startup consumes local
artifacts and never pulls a machine OS or rebuilds images.

## Verification

```bash
pnpm build                       # Web production build
npm --prefix services/agent-host test
pnpm browser:test
pnpm knowledge:test
pnpm runtime:project-supabase:test
```

T1/T2/E1-specific validation and disaster-recovery procedures are in the mode
operations documents:

- [`T1 operations`](./docs/architecture/architectures/t1/operations.md)
- [`T2 operations`](./docs/architecture/architectures/t2/operations.md)
- [`E1 operations`](./docs/architecture/architectures/e1/operations.md)

## Safety rules

- One project owns one durable Project VM. Chat sessions never own an OS.
- Startup fails closed on missing artifacts, missing disks, port conflicts,
  unavailable KVM, cloud-init/SSH timeout or unhealthy services.
- Never silently recreate a project disk to make health checks green; restore
  from backup or require an explicit destructive recovery.
- Secrets, project SSH identities and runtime state stay in protected
  directories; browsers never receive service credentials or direct sandbox
  URLs.
- The Project VM is the host isolation boundary; session workloads are
  additionally isolated by OpenSandbox.
