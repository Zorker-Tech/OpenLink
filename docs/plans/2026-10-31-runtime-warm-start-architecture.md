# Runtime warm-start architecture

Status: implemented phase 1 (golden desktop + persisted fast reattach) with
phase 2/3 planned.

## Problem and measured baseline

Opening a chat pays for five independent layers today:

| Layer | Owner | Cold cost observed on the local Linux/WSL reference host |
| --- | --- | --- |
| Web dev build | Next.js | several seconds per route until the route cache warms |
| Agent Host process | `services/agent-host` | 1–3 s (Node start + service health) |
| Project VM boot | Podman Machine (`qemu`) | ~24 s (`podman machine start`, measured) |
| Project services | Project VM Podman | ~10–40 s (Supabase stack + image checks + container reconciliation + health) |
| Session worker | OpenSandbox | ~3–20 s (container create, image layers, Agent runtime prepare) |
| Ubuntu ISO desktop | QEMU guest in the session | minutes (unattended install per chat) |

The dev log (`~/.cache/openlink/dev-local.log`) showed lease requests at
27–40 s on a cold project, 10–40 s after an Agent Host restart, and 2–3 s in
steady state. `runtime-resources` polls were 3–15 s, dominated by Worker
resource discovery rather than the VM.

Two structural causes stood out:

1. A persisted, healthy Project VM was still re-provisioned from scratch after
   every Agent Host restart because `ensure()` only consulted the in-memory
   `active` map, never the durable `runtime.json`.
2. Every ISO desktop chat installed Ubuntu from the ISO into its own qcow2
   disk. ADR-0026 already named a shared golden disk as the next optimization.

## Target architecture: layered warm state

Each layer has an explicit readiness contract and an owner. A request should
only wait for the layer that is genuinely cold.

```
L0 Web/BFF            prebuilt route cache, no runtime work per request
L1 Agent Host         health endpoint, immutable session registry
L2 Project VM         durable, started at boot for persisted-ready projects
L3 Project services   restart=unless-stopped, health-gated reattach
L4 Session worker     warm pool per Project VM, claimed by lease
L5 Desktop guest      golden qcow2 + per-session COW overlay
```

Invariants:

- A layer may be cold; a lower layer must never be recreated to warm it.
- Readiness is verified by the layer that owns it, never inferred from a
  process handle.
- Warm state is bounded and reclaimable (idle TTL, pool size, memory budget).
- Every fast path has the authoritative provisioning path as its fallback.

## Phase 1 (implemented)

### 1. Persisted runtime fast reattach

`ProjectRuntimeManager.ensure()` now reads the persisted descriptor and
re-attaches when:

- `status` is `ready`, and the descriptor's VM identity matches the current
  `ProjectVmManager` (machine name, guest workspace, backend, ports);
- the current Agent Worker archive revision matches the persisted revision;
  the descriptor also records every runtime image archive revision, so a
  rebuilt Browser/OpenSandbox/code-server image forces provisioning instead
  of reattaching to stale containers;
- the Project VM reports `running` (cheap `machine inspect`, no boot);
- the resident endpoints pass a bounded readiness probe (20 s default,
  injectable for tests).

The fast path does not call `ImageImport`, `ensureProjectSupabase`, or
`ensureContainer`; it only re-establishes SSH port forwards (when the driver
needs them) and verifies health. A stopped VM, a stale image revision, or an
unhealthy service falls through to the original provisioning pipeline in the
same request.

Security: persisted secrets are the same `runtime-secrets.json` already owned
by Agent Host; the fast path never reads a path supplied by a client and never
weakens endpoint validation.

The golden cache lives inside the Project VM trust boundary, which already
contains the shared workspace. A session can technically modify the cache, so
this is a cross-chat persistence surface within the same user/project trust
domain. A future hardening step is an Agent Host-owned golden digest verified
before each boot; it is not required for the first optimization because no
new boundary is crossed.

### 2. Project-scoped golden Ubuntu Desktop

`localhost/agent-worker` and `localhost/agent-rpc-worker` now mount the
Project VM directory `<sessionStorageRoot>/.runtime/desktop` at
`/opt/openlink/desktop-cache`. The verified ISO remains on its separate
read-only mount.

`run-ubuntu-vm.sh` behavior:

- No installed marker: if the golden disk and marker exist, create
  `qemu-img create -f qcow2 -F qcow2 -b golden overlay` and touch the
  session's `installed` marker. Boot is a normal installed-Ubuntu boot.
- Golden missing: the first session builds the installer once, serialized by a
  `flock` on the shared cache, verifies the result with `qemu-img check`,
  publishes it read-only (`0444`), then creates this session's overlay.
- Existing sessions that already own an installed per-chat qcow2 keep using
  it (no migration, no data loss).
- Golden build failure falls back to the previous per-session install.

Result: the ISO install cost is paid once per Project VM instead of once per
chat; later chats and Agent Host restarts get a desktop boot in seconds.

### 3. Verification

- `services/agent-host`: `npm run build` clean.
- `project-runtime` tests: 14/14 pass, including the new reattach test, the
  restart-restore test, and a new test proving one stale session workload that
  cannot restart (for example an OpenSandbox port conflict) is removed instead
  of blocking Project VM activation. The reattach test asserts the service
  driver is not called a second time.
- `project-vm` has one pre-existing environment failure in
  `publishes an independent native CoW clone...` (`qemu-img` rejects
  `-F qcow2` on the test's `.raw` golden); unrelated to this change.
- Desktop VNC is served by websockify before the installed guest exists, so
  the first-boot installer is visible in the chat tab and prewarm no longer
  times out at 60 seconds during the initial install.

### 4. Real-host verification (Linux/WSL reference host)

- Rebuilt `openlink/agent-worker:dev` and `openlink/agent-rpc-worker:dev` with
  the new desktop scripts and re-imported both archives into the Project VM.
  `podman run ... grep golden` inside the VM confirmed the scripts in the
  image.
- Full provisioning after the image change: the first attempt imported the
  3.0 GiB + 2.4 GiB archives, then exposed an existing stale session workload
  holding port 49421. The new recovery path removed it and the retry completed
  in **61.2 s** (VM already running; `servicesMs` 18.7 s). `runtime.json` now
  records all seven `imageRevisions`.
- Persisted fast reattach in a fresh process while the services were resident:
  **135 ms total, 0 `ensureMachine` calls, 0 `ensureServices` calls**.
- Restarting the complete dev stack left `runtime.json` unchanged and the
  Project Supabase/OpenSandbox/Browser/code-server containers at their original
  12-minute uptime, proving the restore sweep adopted them instead of
  re-provisioning.
- Golden overlay on the real Project VM: with a synthetic golden disk and the
  real ISO mounted, the worker created `system.qcow2` with
  `backing file: /opt/openlink/desktop-cache/ubuntu-desktop-golden.qcow2`,
  touched the `installed` marker, and booted QEMU with KVM. The synthetic test
  was removed afterward; the project cache was not polluted.

## Phase 2: warm session pool

The vendored OpenSandbox SDK exports `SandboxPool` with `AcquirePolicy`,
staged warmup, health checks and idle TTL. The next step is a per-Project,
single-node pool:

- Pool size 1 per Project VM by default (`OPENLINK_AGENT_POOL_SIZE`), created
  after project services become ready and before the first chat.
- A pooled sandbox is a normal Agent Worker container with the session volume
  mounted but no chat identity; the lease assigns the durable session id,
  writes the native snapshot, and starts or resumes the Worker.
- Pool acquisition must happen after `prepareSessionStorage`; pool warmup must
  never create user-visible session state.
- Desktop prewarm moves from "after lease" to "after pool slot creation" so
  the overlay VM is already booting when the tab opens.
- Fail closed: a pool miss creates a sandbox through today's path; a pool
  health failure destroys only the bad slot.

This targets the remaining 3–20 s worker cost and removes the largest
remaining variance.

## Phase 3: eager project warm-up and telemetry

- Start persisted-ready Project VMs in parallel at Agent Host startup with a
  bounded concurrency (for example 2) instead of the current sequential sweep.
- Add phase timings to every provisioning path:
  `vm_boot`, `supabase_ready`, `images_ready`, `services_ready`,
  `worker_ready`, `desktop_ready`, `reattach`. Emit them as structured logs
  and expose them through the existing runtime status projection.
- Set explicit budgets (VM ≤ 25 s cold / ≤ 1 s warm; services ≤ 15 s;
  worker ≤ 5 s warm; desktop ≤ 15 s after golden exists; golden build ≤ 20 min
  once per Project).
- Size the ISO Project VM for the nested guest. The local default is 8 GiB,
  while the ISO desktop guest requests 6 GiB before Project Supabase and the
  control-plane services. Set `OPENLINK_PROJECT_VM_MEMORY_MB=16384` on hosts
  with enough RAM; the remote ISO default is already 16 GiB.
- Consider baking the golden desktop into the Project VM Golden Disk build
  (`runtime:vm-image`) so even the first Project VM in a fresh installation
  never needs an installer run. That is a build-artifact change and needs its
  own ADR update.

## Migration and rollback

- Golden cache: additive. Delete
  `<sessionStorageRoot>/.runtime/desktop` to force a rebuild. Existing
  per-session installed disks are untouched.
- Fast reattach: internal. Remove the persisted fast path or set
  `reattachProbeTimeoutMs: 0` in an embedded runtime to force provisioning.
- No schema, protocol, or credential change in either phase.
