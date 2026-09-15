# Agent session runtime implementation plan

**Goal:** Fix repeated Codex/Pi preparation failures and expose real native session controls and context statistics, validated against the running application.

**Architecture:** Keep durable message receipt independent from optional Browser readiness. Diagnose and repair lifecycle/recovery races in Host and sandbox provisioning; expose native capabilities through authenticated session routes, with explicit unsupported states. Preserve existing session data and working-tree changes.

**Tech Stack:** Next.js, TypeScript, Agent Host, OpenSandbox, Codex App Server, Pi RPC.

## 1. Preparation reliability

- Inspect `app/api/chat/[session_id]/events/route.ts`, `services/agent-host/src/prompt-http-server.ts`, and `services/agent-host/src/backends/local-opensandbox.ts` against live VM/Host logs.
- Add regression tests in `scripts/test/chat-receipt.test.mjs` and Host tests for the observed failure: startup cancellation, concurrent warmup/prompt/browser attachment, stale workload cleanup, and safe diagnostics.
- Run tests before and after minimal repair. Do not substitute longer timeouts for lifecycle correctness.

## 2. Native capability and control mapping

- Audit Worker Codex/Pi implementations and the composer protocol before implementing commands.
- Connect interrupt, pause/resume, steer and message editing with durable event semantics; do not pretend editing historical UI text rewrites native context.
- Connect Codex plan mode and available goal APIs from the installed protocol; explicitly distinguish unavailable capabilities and app-level orchestration.
- Test authorization, busy/idle transitions, failures and refresh persistence.

## 3. Context statistics

- Trace native usage events through adapters and persistence to `/context` and the top bar.
- Separate cumulative billed tokens from current context occupancy; unknown values remain unknown.
- Add fixtures for Codex and Pi, compaction and empty sessions.

## 4. Acceptance

- Run targeted tests and Host/Worker checks, then production build.
- Update running artifacts where needed, preserving VM/project storage.
- Verify fresh and resumed Codex and Pi sessions with real completed replies, Browser unbound and attached, controls, edited follow-up, plan/goal capability, and refreshed context values.
- Record exact passing and blocked cases; a provider error is not a successful smoke test.

## Live evidence so far (2026-09-06)

- Pi session `3mY8XkiqjUY` (project `e5faa193-d5f1-4981-8a94-a402c084e600`) returned `OPENLINK_PI_SMOKE_OK`, `OPENLINK_RECONNECT_OK` while Browser was starting, `OPENLINK_STEER_OK` through native steering, and `OPENLINK_EDIT_OK` after editing/re-sending. Original records retained.
- Manual pause confirmed in UI and Host; persisted `.session-controls` state stayed paused after refresh. Unit test also covers Host restart and explicit resume.
- Codex session `1x1zGD6Shyo` reached native turn execution, then OpenCode Go `/responses` rejected gpt-5.6-luna with `403 unsupported_country_region_territory`. Not a passing completion test. Testing another configured model (minimax-m3) uncovered a preparation failure and stale initial-model warmup interference; ongoing diagnosis.
- Installed Worker Codex CLI: `0.153.3`. Real protocol probe confirms `collaborationMode/list` returns Plan/Default only after initialize opts into `experimentalApi`. Handshake fixed; second Worker rebuild pending.
- Root-cause repairs: preserve tunnels on transient health timeout; Agent health scope excludes Browser/Studio; coalesce health bursts; register cancellation before VM preparation; background warmups no longer restore stale initial model.
- Context repairs: Codex native usage events, Pi cache accounting without double counting, latest context separate from cumulative usage, unknown when unreported/after compaction, no database request per streamed token.
- Tests passed: 29 adapter/control/context/receipt/lifecycle tests, 35 Host/project/control tests, 4 authenticated control-route tests, plus 6 sandbox recovery checks. Full repository typecheck has existing unrelated errors; modified files passed targeted diagnostic filtering. Production build succeeds with repository's existing skip-typecheck configuration.
- Runtime is launchd job `com.openlink.local.production` (NOT the obsolete `com.openlink.dev.local`). Logs: `/Users/yikewang/Library/Logs/OpenLink/production.{stdout,stderr}.log`. Restore with the Node 26 PATH and `node scripts/openlink.mjs --mode production` as a submitted launchd job.
- Must finish: second image deployment, real Plan/Goal UI acceptance, Pi interrupt/compact, Codex completed reply or exact external blocker, repeated fresh/resumed smoke after final changes. Do not mark goal complete yet.

### Subsequent root causes / deployment checkpoint

- Podman engine evidence: Egress creation failed with `cannot bind tcp port :47882: address already in use` and `:47761`. Container-local socket probes cannot guarantee VM-host port availability. Added bounded collision-only retry around sidecar creation under the same sandbox id; non-port errors are not retried. OpenSandbox tests: **137 passed**.
- Latest native startup failure was `no rollout found for thread id ...`. Added this exact native missing-history response to the replacement fallback while preserving fail-closed behavior for transient resume errors. Model changes now resume the same native thread with updated configuration rather than silently discarding history.
- Full Agent Host suite: **106 passed**. Outer message/lease preparation budgets now 300s (greater than Sandbox's 180s + native Worker preparation); explicit cancellation is tested before and after response headers.
- Latest in-progress rebuild exports both Worker and OpenSandbox server (`OPENLINK_RUNTIME_IMAGES=openlink/agent-worker:dev,openlink/opensandbox-server:dev`). Unified exec session **48752**. App/Project VM deliberately stopped for builder. Restore production launchd after builder completes; never leave them stopped.
- Worker image being exported is `2a8eac605feb...`; preceding deployed Worker `2b26ddfccfd8...` did not yet handle the exact `no rollout found` string.
- Browser handles in persistent CUA: `tab` (id 1, Pi), `codexTab` (id 2, Codex). Old chunks caused reload failures during live builds: stop/build/restart and navigate via `/app` then click the known chat to get a fresh document. Do not build into `.next` while performing browser acceptance.
- OpenSandbox docs build lacked VitePress. A no-lockfile, ignore-scripts install of declared docs dependencies + docs build is in progress (exec session returned in tool output). Keep package manifests unchanged.

### Latest checkpoint

- OpenSandbox documentation now builds successfully; Ruff passes for changed Python files. No docs manifest/lockfile changes.
- Deployed OpenSandbox `735a55cdf4e3` was verified by importing `with_port_binding_retry` inside the real control-plane container.
- Real Codex native Plan switched successfully, and `/goal` created a goal. Native `status` returned mode `plan` and goal status `blocked` with 0 tokens, reflecting upstream rejection. UI now renders goal status and usage, not just objective text.
- Both configured Codex test routes are externally blocked: gpt-5.6-luna gets region 403; minimax-m3 gets 401 with `Model minimax-m3 is not supported for format openai` from the same Responses endpoint. Preparation succeeded after the local fixes; no Codex completion can be claimed.
- Real Pi interrupt produced a persisted cancellation and returned idle. Manual compaction returned the native `Nothing to compact (session too small)`. Host/UI now normalize this exact safe no-op into an explanatory notice; it must not be presented as an actual compaction. Zero-usage placeholders from cancellation now leave context occupancy unknown.
- Added Plan `item/tool/requestUserInput` answer routing, numeric approval-id preservation, canonical confirmation resolution, and explicit rejection of unsupported server RPCs instead of hanging. Choice/free-input/skip round-trip tests pass. Question UI can wrap instead of clipping into one line.
- Current pending image build: unified exec **20652**, Worker **4b73e110b9a2**. App and project VM are stopped for this build. After completion restore `com.openlink.local.production`, wait for actual health/image readiness, then verify Pi reply/no-op compaction/unknown occupancy, Goal blocked status, and clear the disposable test goal. Keep the root goal active; full Codex provider completion remains unverified.

## Handoff state after deployment

- Production launchd service is restored and `/api/healthz` returns `ok: true`.
- Project VM is ready with Worker archive revision `1259560960:1788632664207` (image `4b73e110b9a2`); OpenSandbox image `735a55cdf4e3` was verified running with the port retry helper.
- Latest real Pi reply: `OPENLINK_FINAL_READY`. Context changed from unknown after cancellation to native usage **2.8%** after the next successful turn. Short-session compaction displays the native no-op notice, not an error. Earlier steering, editing, restart/resume and interrupt checks passed.
- Latest real Codex UI restored **Plan** plus **Goal (blocked), 0 tokens** after VM restart. The disposable goal was then explicitly cleared by checking its exact test objective; mode restored to default, native busy=false. Test chat and error messages are retained.
- Current test runs: 106 Host + 137 OpenSandbox + 37 chat/adapter/control tests = **280 passing tests**. Web and OpenSandbox docs builds pass. Full repo TypeScript baseline remains failing in unrelated files; changed-file diagnostics were clean.
- Native Plan question/approval round-trip and ID preservation have regression coverage; model-driven question generation and a successful Codex model reply cannot be accepted without a usable Responses upstream.
- **External input required to finish the root goal:** configure an authorized, working Responses-compatible provider. Existing OpenCode Go gpt-5.6-luna returns region 403, and minimax-m3 returns 401 because Responses/openai format is unsupported. Global provider, proxy, and default-model settings were not changed. Root goal is intentionally not complete.
- Official native protocol reference: [Codex App Server](https://learn.chatgpt.com/docs/app-server).

## Goal continuation audit 2

- Previous goal turn: **progress**, with deployed fixes and real Pi/native-control evidence, but incomplete Codex model acceptance.
- Current live Worker was confirmed `running` on image `4b73e110b9a2` before probing. At `2026-09-05T18:43:08Z`, bounded Responses probes through its existing credential vault still returned gpt-5.6-luna **403 / region_unavailable** and minimax-m3 **401 / responses_format_unsupported**. No provider/proxy/default settings changed.
- Added `scripts/smoke-provider-responses.mjs` to reproduce this precise boundary without printing credentials or adding chat messages.
- Added and ran `scripts/smoke-codex-schema.mjs` inside the actual Worker. The installed CLI's experimental JSON Schema confirms the implemented question-answer/skip shape and native Goal status contract. Relevant 8 control/context tests passed again. This strengthens protocol coverage, but does not substitute for model-driven Plan/Goal acceptance.
- Same external blocker has now appeared in two consecutive goal turns. Root goal remains active, not complete or blocked yet; a working authorized Responses upstream is still required for full acceptance.

## Goal continuation audit 3 — blocked

- Previous turn was progress: native-schema verification and reusable bounded upstream probes were added and executed. It did not prove full completion.
- Current live inspection again confirmed the test Worker running on `4b73e110b9a2`, and application health returned `ok: true`.
- Fresh probes at `2026-09-05T18:48:53Z` / `18:48:54Z` again returned gpt-5.6-luna **403 region_unavailable** and minimax-m3 **401 responses_format_unsupported**. The probe process finished normally; no verification process is being abandoned or inferred stopped from a stale file.
- The same external Responses availability blocker has persisted across three consecutive goal turns. Full Codex replies and model-driven Plan/Goal acceptance remain unproven. No local code change can authorize the rejected upstream region or make that provider offer an unsupported Responses model format.
- Mark the unchanged full objective **blocked**, not complete, pending a working authorized Responses configuration or upstream recovery. Existing services, data, test evidence, and fixes remain in place. Do not keep issuing the same failed requests automatically.
