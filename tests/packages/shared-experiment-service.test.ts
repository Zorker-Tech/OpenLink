/**
 * The experiment service: the bundled answers before anything is up, what a bootstrap (cached, fetched or discarded)
 * does to them, the local overrides a development build may set, what it waits for and what it reports, and what
 * disposal stops.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  BASE_POLL_INTERVAL_MS,
  BOOTSTRAP_TIMEOUT_MS,
  GATE_READY_TIMEOUT_MS,
  MIN_POLL_INTERVAL_MS,
  POLL_JITTER_FRACTION,
  SlateExperimentService,
  computePollDelayMs,
  envGateOverride,
  jitteredSlateExperimentPollIntervalMs,
} from "../../source/shared/node/experiments/slate-experiment-service.ts";
import { BOOTSTRAP_CACHE_FILENAME, saveCachedBootstrap } from "../../source/shared/node/experiments/slate-experiment-bootstrap.ts";
import { DYNAMIC_CONFIGS, EXPERIMENTS, FLAGS } from "../../source/shared/node/experiments/experiment-config.gen.ts";
import { pinExperimentsDiagnosticsReporter, type ExperimentDiagnostic } from "../../source/shared/node/experiments/experiments-diagnostics.ts";
import { FEATURE_FLAG_OVERRIDES_FILENAME } from "../../source/shared/node/experiments/feature-flag-overrides.ts";
import { SLATE_MODEL_EXPERIMENT_NAME } from "../../source/shared/node/experiments/slate-model-experiment.ts";

const BACKEND = "https://backend.slate.invalid/";
const GATED_FLAG = "slate_browser_use_subagent";
const ON_BY_DEFAULT_FLAG = "slate_computer_use_playwright";

const MODEL_SELECTION = { value: { enabled: true }, group_name: "treatment" };
const DEFAULT_MODEL = { value: { modelId: "gpt-5.6-luna", maxMode: false, parameters: [{ id: "effort", value: "low" }] } };

function configOf(parts: { user?: boolean | Record<string, unknown>; gates?: Record<string, boolean>; configs?: Record<string, unknown>; experiment?: boolean } = {}) {
  return JSON.stringify({
    ...(parts.user === false ? {} : { user: parts.user === undefined || parts.user === true ? { userID: "user-1" } : parts.user }),
    feature_gates: Object.fromEntries(Object.entries(parts.gates ?? {}).map(([name, value]) => [name, { value }])),
    dynamic_configs: parts.configs ?? {},
    experiments: parts.experiment === false ? {} : { [SLATE_MODEL_EXPERIMENT_NAME]: MODEL_SELECTION },
  });
}

const CONFIG = configOf({
  gates: { [GATED_FLAG]: true },
  configs: {
    slate_default_model: DEFAULT_MODEL,
    slate_automations_model: { value: { modelId: "claude-opus-4-8", maxMode: false, parameters: [] } },
    slate_model_filter: { value: { allowedModelIds: ["one", "two", "one"], defaultParameters: {} } },
    slate_computer_use_playwright_config: { value: { modelId: "gpt-5.6-luna", maxMode: true, parameters: [] } },
  },
});

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

type FetchCall = { url: string; init: RequestInit };
type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

function responseOf(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function bootstrapResponse(config: string, status = 200): Response {
  return responseOf({ config }, status);
}

function serviceWorld(options: { isDevBuild?: boolean; pollIntervalMs?: number; env?: Record<string, string>; fetch?: FetchImpl; token?: string | null; seedOverrides?: Record<string, boolean> } = {}) {
  const cacheDir = mkdtempSync(join(tmpdir(), "slate-experiments-"));
  if (options.seedOverrides != null) {
    const overrides: Record<string, { value: boolean; expiresAtMs: number }> = {};
    for (const [name, value] of Object.entries(options.seedOverrides)) overrides[name] = { value, expiresAtMs: Date.now() + 60_000 };
    writeFileSync(join(cacheDir, FEATURE_FLAG_OVERRIDES_FILENAME), JSON.stringify({ overrides }), "utf8");
  }
  const fetchCalls: FetchCall[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    fetchCalls.push(call);
    if (options.fetch != null) return await options.fetch(call.url, call.init);
    return bootstrapResponse(CONFIG);
  }) as typeof fetch;
  restores.push(() => {
    globalThis.fetch = previousFetch;
  });
  const diagnostics: ExperimentDiagnostic[] = [];
  pinExperimentsDiagnosticsReporter((diagnostic) => diagnostics.push(diagnostic));
  diagnostics.length = 0;
  restores.push(() => pinExperimentsDiagnosticsReporter(null));
  const env = { SLATE_BACKEND_URL: BACKEND, ...(options.env ?? {}) };
  const service = new SlateExperimentService({
    getAccessToken: async () => {
      if (options.token === null) throw new Error("no token");
      return options.token ?? "token-1";
    },
    getMachineId: async () => "machine-1",
    getCacheDir: () => cacheDir,
    ...(options.isDevBuild === undefined ? {} : { isDevBuild: options.isDevBuild }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    env: env as NodeJS.ProcessEnv,
  });
  restores.push(() => {
    void service.dispose();
  });
  return {
    service,
    cacheDir,
    fetchCalls,
    diagnostics,
    named: (kind: string) => diagnostics.filter((diagnostic) => diagnostic.kind === kind),
    bootstrapCalls: () => fetchCalls.filter((call) => call.url.includes("BootstrapStatsig")),
    logCalls: () => fetchCalls.filter((call) => call.url.includes("/log")),
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("what the experiment service computes on its own", () => {
  it("jitters its poll interval, and reads the gate overrides out of the environment", () => {
    assert.deepEqual([BASE_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS, POLL_JITTER_FRACTION, BOOTSTRAP_TIMEOUT_MS, GATE_READY_TIMEOUT_MS], [300_000, 30_000, 0.3, 30_000, 10_000]);
    assert.deepEqual(
      [
        computePollDelayMs({ baseIntervalMs: 1_000, jitterRoll: 0 }),
        computePollDelayMs({ baseIntervalMs: 1_000, jitterRoll: 1 }),
        computePollDelayMs({ baseIntervalMs: 1_000, jitterRoll: -1 }),
        computePollDelayMs({ baseIntervalMs: 1_000, jitterRoll: 1, retryAfterMs: 2_000 }),
        computePollDelayMs({ baseIntervalMs: 1_000, jitterRoll: 1, retryAfterMs: 500 }),
      ],
      [1_000, 1_300, 700, 2_000, 1_300],
    );
    assert.deepEqual(
      [jitteredSlateExperimentPollIntervalMs(false, () => 0), jitteredSlateExperimentPollIntervalMs(false, () => 1), jitteredSlateExperimentPollIntervalMs(true, () => 1)],
      [300_000, 390_000, 39_000],
    );
    const world = serviceWorld({ env: { SLATE_FEATURE_GATE_OVERRIDES: `${GATED_FLAG}=1` } });
    assert.equal(world.service.checkFeatureGate(GATED_FLAG), FLAGS[GATED_FLAG].default);
    const env = { SLATE_FEATURE_GATE_OVERRIDES: " first = 1 , second=true, third = on , fourth=0 , fifth=maybe " };
    assert.deepEqual(
      [envGateOverride("first", env), envGateOverride("second", env), envGateOverride("third", env), envGateOverride("fourth", env), envGateOverride("fifth", env), envGateOverride("missing", env)],
      [true, true, true, false, false, undefined],
    );
    assert.deepEqual([envGateOverride("first", {}), envGateOverride("first", { SLATE_FEATURE_GATE_OVERRIDES: "" })], [undefined, undefined]);
  });
});

describe("what the experiment service answers", () => {
  it("answers from the bundled values until anything is up", () => {
    const world = serviceWorld();
    const snapshot = world.service.getSnapshot();
    assert.deepEqual([snapshot.isInitialized, world.service.hasLiveBootstrap(), world.service.hasAuthenticatedBootstrap(), world.service.hasHydratedExperimentUser(), world.service.getFlagsAgeMs()], [false, false, false, false, undefined]);
    assert.deepEqual([world.service.checkFeatureGate(GATED_FLAG), world.service.checkFeatureGate(ON_BY_DEFAULT_FLAG)], [FLAGS[GATED_FLAG].default, FLAGS[ON_BY_DEFAULT_FLAG].default]);
    assert.deepEqual(world.service.getExperiment(SLATE_MODEL_EXPERIMENT_NAME), EXPERIMENTS[SLATE_MODEL_EXPERIMENT_NAME].fallbackValues);
    assert.deepEqual(world.service.getDynamicConfig("slate_default_model"), DYNAMIC_CONFIGS.slate_default_model.fallbackValues);
    assert.deepEqual([world.service.getExperimentGroupName(SLATE_MODEL_EXPERIMENT_NAME), world.service.getSlateModelExperimentState()], [null, undefined]);
    assert.deepEqual(Object.keys(snapshot.experiments), Object.keys(EXPERIMENTS));
    assert.deepEqual(world.service.getConfiguredDefaultModel(), undefined);
    assert.deepEqual(world.service.getComputerUseModelOverride(), DYNAMIC_CONFIGS.slate_computer_use_playwright_config.fallbackValues);
    assert.deepEqual(world.service.getBrowserUseModelOverride(), undefined);
    assert.equal(snapshot.featureFlags, undefined);
  });

  it("refreshes now, and answers from what came back", async () => {
    const world = serviceWorld();
    const seen: unknown[] = [];
    world.service.subscribe((snapshot) => seen.push(snapshot));
    await world.service.refreshNow();
    assert.deepEqual([world.service.hasLiveBootstrap(), world.service.hasAuthenticatedBootstrap(), world.service.hasHydratedExperimentUser()], [true, true, true]);
    assert.deepEqual([world.service.checkFeatureGate(GATED_FLAG), world.service.checkFeatureGate(ON_BY_DEFAULT_FLAG)], [true, true]);
    assert.deepEqual(world.service.getDynamicConfig("slate_default_model"), { modelId: "gpt-5.6-luna", maxMode: false, parameters: [{ id: "effort", value: "low" }] });
    assert.deepEqual(world.service.getConfiguredDefaultModel(), { modelId: "gpt-5.6-luna", maxMode: false, parameters: [{ id: "effort", value: "low" }] });
    assert.deepEqual(world.service.getConfiguredAutomationsModel(), { modelId: "claude-opus-4-8", maxMode: false, parameters: [] });
    assert.equal(typeof world.service.getFlagsAgeMs(), "number");
    assert.equal(world.service.getSnapshot().isInitialized, true);
    // The bootstrap was asked of the host's backend, with the token and a machine checksum.
    const call = world.bootstrapCalls()[0];
    assert.deepEqual([call?.url.startsWith(BACKEND), call?.init.method], [true, "POST"]);
    const headers = call?.init.headers as Headers;
    assert.deepEqual([headers.get("authorization"), headers.get("x-cursor-checksum")?.includes("machine-1")], ["Bearer token-1", true]);
    // What came back is written down for the next start, and everyone listening heard about it.
    const cached = JSON.parse(readFileSync(join(world.cacheDir, BOOTSTRAP_CACHE_FILENAME), "utf8")) as { config: string; userId: string; fetchedAtMs: number };
    assert.deepEqual([cached.config, cached.userId, typeof cached.fetchedAtMs], [CONFIG, "user-1", "number"]);
    assert.deepEqual(seen.length, 1);
    const resolved = world.named("bootstrap_resolved")[0];
    assert.deepEqual([resolved?.stage, resolved?.authenticated], ["manual", true]);
    // The count is how many gates the snapshot says are on, not how many the config mentioned.
    assert.equal(resolved?.gatesOnCount, Object.values(world.service.getSnapshot().featureGates).filter(Boolean).length);
    assert.deepEqual(world.service.getSlateModelExperimentState(), { active: true, arm: "treatment" });
    assert.deepEqual(world.service.getComputerUseModelOverride(), { modelId: "gpt-5.6-luna", maxMode: true, parameters: [] });
  });

  it("keeps a live but anonymous bootstrap out of the identity-bound answers", async () => {
    const world = serviceWorld({ fetch: async () => bootstrapResponse(configOf({ user: false, gates: { [GATED_FLAG]: true }, configs: { slate_model_filter: { value: { allowedModelIds: ["one"] } } } })) });
    await world.service.refreshNow();
    assert.deepEqual([world.service.hasLiveBootstrap(), world.service.hasAuthenticatedBootstrap(), world.service.hasHydratedExperimentUser()], [true, false, false]);
    assert.equal(world.service.checkFeatureGate(GATED_FLAG), true);
    // Nothing identity-bound is applied without an identity, and the refusal is reported once.
    assert.equal(world.service.getConfiguredDefaultModel(), undefined);
    assert.equal(world.service.getSlateModelExperimentState(), undefined);
    assert.deepEqual(world.named("config_not_applied").map((diagnostic) => [diagnostic.stage, diagnostic.reason]), [["slate_default_model", "identity_unhydrated"]]);
    assert.equal(world.service.getConfiguredDefaultModel(), undefined);
    await world.service.refreshNow();
    assert.equal(world.named("config_not_applied").length, 1);
    // Every bootstrap that landed said it was not authenticated.
    assert.deepEqual([...new Set(world.named("bootstrap_resolved").map((diagnostic) => diagnostic.authenticated))], [false]);
    // The model filter's allowed ids are only carried for an authenticated bootstrap.
    assert.equal(world.service.getSnapshot().slateModelFilterAllowedIds, undefined);
    const emptyIdentity = serviceWorld({ fetch: async () => bootstrapResponse(configOf({ user: { userID: "" } })) });
    await emptyIdentity.service.refreshNow();
    assert.deepEqual([emptyIdentity.service.hasLiveBootstrap(), emptyIdentity.service.hasAuthenticatedBootstrap(), emptyIdentity.service.hasHydratedExperimentUser()], [true, false, false]);
  });

  it("carries the model filter's allowed models when no experiment decides, deduplicated", async () => {
    const world = serviceWorld({
      fetch: async () =>
        bootstrapResponse(
          configOf({
            experiment: false,
            configs: { slate_model_filter: { value: { allowedModelIds: ["one", "two", "one"], defaultParameters: {} } } },
          }),
        ),
    });
    await world.service.refreshNow();
    assert.deepEqual(world.service.getSlateModelExperimentState(), undefined);
    assert.deepEqual(world.service.getSnapshot().slateModelFilterAllowedIds, ["one", "two"]);
    assert.equal(world.service.getSnapshot().slateModelExperiment, undefined);
    // A list with something that is not an id is no list at all.
    const mixed = serviceWorld({ fetch: async () => bootstrapResponse(configOf({ experiment: false, configs: { slate_model_filter: { value: { allowedModelIds: ["one", 2] } } } })) });
    await mixed.service.refreshNow();
    assert.equal(mixed.service.getSnapshot().slateModelFilterAllowedIds, undefined);
    const empty = serviceWorld({ fetch: async () => bootstrapResponse(configOf({ experiment: false, configs: { slate_model_filter: { value: { allowedModelIds: [] } } } })) });
    await empty.service.refreshNow();
    assert.equal(empty.service.getSnapshot().slateModelFilterAllowedIds, undefined);
  });

  it("leaves the platform where it was when the bootstrap failed or was refused", async () => {
    const failing = serviceWorld({
      fetch: async () => {
        throw new Error("the backend is unreachable");
      },
    });
    await failing.service.refreshNow();
    assert.deepEqual([failing.service.hasLiveBootstrap(), failing.service.checkFeatureGate(GATED_FLAG)], [false, FLAGS[GATED_FLAG].default]);
    assert.deepEqual(failing.named("bootstrap_failed").map((diagnostic) => [diagnostic.stage, typeof diagnostic.errorClass]), [["manual", "string"]]);
    // A refused bootstrap says how long to wait, and the wait is honoured before asking again.
    const limited = serviceWorld({ fetch: async () => new Response("{}", { status: 429, headers: { "retry-after": "0.05" } }) });
    await limited.service.refreshNow();
    const startedAt = Date.now();
    await limited.service.refreshNow();
    assert.deepEqual([limited.bootstrapCalls().length, Date.now() - startedAt >= 40, limited.service.hasLiveBootstrap()], [2, true, false]);
  });

  it("throws away a bootstrap that arrived after the account changed under it", async () => {
    let calls = 0;
    const world = serviceWorld({
      fetch: async () => {
        calls += 1;
        // The account changes while the very first bootstrap is being answered.
        if (calls === 1) world.service.handleAuthChange();
        return bootstrapResponse(CONFIG);
      },
    });
    await world.service.refreshNow();
    await waitUntil(() => world.named("bootstrap_resolved").length >= 1);
    assert.deepEqual([world.service.hasLiveBootstrap(), world.service.hasAuthenticatedBootstrap()], [true, true]);
    // The bootstrap that was in flight is thrown away, and the one the change asked for is what lands.
    assert.deepEqual(world.named("bootstrap_discarded_auth_changed").map((diagnostic) => diagnostic.stage), ["manual"]);
    assert.deepEqual(world.named("bootstrap_resolved").map((diagnostic) => diagnostic.stage), ["auth_change"]);
  });

  it("starts from what it cached, then keeps polling", async () => {
    const world = serviceWorld({ pollIntervalMs: 10 });
    await saveCachedBootstrap(world.cacheDir, { config: configOf({ gates: { [GATED_FLAG]: true } }), userId: "user-1", fetchedAtMs: Date.now() - 5_000 });
    world.service.start();
    // The cached config is up before the first fetch lands.
    assert.deepEqual([world.service.checkFeatureGate(GATED_FLAG), world.service.getSnapshot().isInitialized], [true, true]);
    assert.equal(typeof world.service.getFlagsAgeMs(), "number");
    await waitUntil(() => world.named("bootstrap_resolved").length >= 2);
    assert.equal(world.named("bootstrap_resolved").length >= 2, true);
    assert.deepEqual(world.named("bootstrap_resolved").map((diagnostic) => diagnostic.stage).slice(0, 2), ["startup", "poll"]);
    await world.service.dispose();
  });

  it("waits for a live bootstrap only when asked to, and for a hydrated user up to a deadline", async () => {
    const world = serviceWorld();
    assert.equal(await world.service.checkGate(GATED_FLAG), FLAGS[GATED_FLAG].default);
    assert.equal(await world.service.checkGate(GATED_FLAG, { timeoutMs: 0 }), FLAGS[GATED_FLAG].default);
    assert.equal(await world.service.waitForHydratedExperimentUser(5), false);
    // A refresh in flight that hydrates the user settles the wait.
    const gate = deferred<void>();
    const pending = serviceWorld({ fetch: async () => {
      await gate.promise;
      return bootstrapResponse(CONFIG);
    } });
    const refresh = pending.service.refreshNow();
    const waiting = pending.service.waitForHydratedExperimentUser(500);
    gate.resolve();
    await refresh;
    assert.deepEqual([await waiting, pending.service.hasHydratedExperimentUser()], [true, true]);
    // A gate question waits for a refresh that is on its way, and answers from it.
    const slowGate = deferred<void>();
    const slow = serviceWorld({ fetch: async () => {
      await slowGate.promise;
      return bootstrapResponse(CONFIG);
    } });
    const slowRefresh = slow.service.refreshNow();
    const answered = slow.service.checkGate(GATED_FLAG, { timeoutMs: 500 });
    assert.equal(slow.service.checkFeatureGate(GATED_FLAG), FLAGS[GATED_FLAG].default);
    slowGate.resolve();
    assert.deepEqual([await answered, await slowRefresh], [true, undefined]);
    // A refresh that never lands does not hold a gate question past its deadline.
    const hung = deferred<void>();
    const stuck = serviceWorld({ fetch: async () => {
      await hung.promise;
      return bootstrapResponse(CONFIG);
    } });
    const stuckRefresh = stuck.service.refreshNow();
    assert.equal(await stuck.service.checkGate(GATED_FLAG, { timeoutMs: 5 }), FLAGS[GATED_FLAG].default);
    hung.resolve();
    await stuckRefresh;
    // And a live bootstrap makes a gate question immediate.
    await world.service.refreshNow();
    assert.equal(await world.service.checkGate(GATED_FLAG), true);
  });

  it("pins a gate when the bootstrap that knows about accounts arrives", async () => {
    const anonymous = serviceWorld({ fetch: async () => bootstrapResponse(configOf({ user: false, gates: { [GATED_FLAG]: true } })) });
    const pinned: boolean[] = [];
    anonymous.service.pinGateOnAuthenticatedBootstrap(GATED_FLAG, (value) => pinned.push(value));
    await anonymous.service.refreshNow();
    assert.deepEqual([pinned.length, anonymous.service.hasAuthenticatedBootstrap()], [0, false]);
    // The next bootstrap carries an identity, so the gate is pinned then.
    const authenticated = serviceWorld();
    const immediate: boolean[] = [];
    await authenticated.service.refreshNow();
    authenticated.service.pinGateOnAuthenticatedBootstrap(GATED_FLAG, (value) => immediate.push(value));
    assert.deepEqual(immediate, [true]);
  });

  it("reads the model experiment from the environment, the arm or nothing", async () => {
    const overridden = serviceWorld({ env: { SLATE_MODEL_EXPERIMENT_OVERRIDE: "control" } });
    assert.deepEqual(overridden.service.getSlateModelExperimentState(), { active: true, arm: "control" });
    const world = serviceWorld();
    assert.equal(world.service.getSlateModelExperimentState(), undefined);
    await world.service.refreshNow();
    assert.deepEqual(world.service.getSlateModelExperimentState(), { active: true, arm: "treatment" });
    assert.equal(world.service.logSlateModelExperimentExposure(), true);
    // The exposure flush goes to the platform's own log endpoint, never to the bootstrap.
    await waitUntil(() => world.logCalls().length >= 1);
    assert.deepEqual(world.logCalls().map((call) => call.url), ["https://experiments.slate.invalid/log"]);
    assert.equal(world.bootstrapCalls().length, 1);
    const anonymous = serviceWorld({ fetch: async () => bootstrapResponse(configOf({ user: false })) });
    await anonymous.service.refreshNow();
    assert.equal(anonymous.service.logSlateModelExperimentExposure(), false);
    const armless = serviceWorld({ fetch: async () => bootstrapResponse(JSON.stringify({ user: { userID: "user-1" }, experiments: { [SLATE_MODEL_EXPERIMENT_NAME]: { value: { enabled: true } } } })) });
    await armless.service.refreshNow();
    assert.equal(armless.service.logSlateModelExperimentExposure(), false);
  });

  it("reads the browser-use and computer-use overrides through their own gates", async () => {
    const browserConfig = { value: { modelId: "gpt-5.6-luna", maxMode: false, parameters: [] } };
    const off = async () => bootstrapResponse(configOf({ gates: { [GATED_FLAG]: false }, configs: { slate_browser_use_model: browserConfig, slate_computer_use_playwright_config: { value: { modelId: "gpt-5.6-luna", maxMode: true, parameters: [] } } } }));
    const world = serviceWorld({ fetch: off });
    await world.service.refreshNow();
    assert.deepEqual([world.service.getComputerUseModelOverride(), world.service.getBrowserUseModelOverride()], [{ modelId: "gpt-5.6-luna", maxMode: true, parameters: [] }, undefined]);
    world.service.setFeatureFlagOverride(GATED_FLAG, true);
    assert.equal(world.service.canUseFeatureFlagOverrides(), false);
    assert.equal(world.service.getBrowserUseModelOverride(), undefined);
    const computerOff = serviceWorld({ fetch: async () => bootstrapResponse(configOf({ gates: { [ON_BY_DEFAULT_FLAG]: false } })) });
    await computerOff.service.refreshNow();
    assert.deepEqual([computerOff.service.checkFeatureGate(ON_BY_DEFAULT_FLAG), computerOff.service.getComputerUseModelOverride()], [false, undefined]);
    const dev = serviceWorld({ isDevBuild: true, fetch: off });
    await dev.service.refreshNow();
    dev.service.setFeatureFlagOverride(GATED_FLAG, true);
    assert.deepEqual(dev.service.getBrowserUseModelOverride(), { modelId: "gpt-5.6-luna", maxMode: false, parameters: [] });
  });
});

describe("the overrides a development build may set", () => {
  it("reads an override before the environment, and the environment before the bootstrap", async () => {
    const world = serviceWorld({ isDevBuild: true, env: { SLATE_FEATURE_GATE_OVERRIDES: `${GATED_FLAG}=1` } });
    assert.deepEqual([world.service.checkFeatureGate(GATED_FLAG), world.service.checkFeatureGate(ON_BY_DEFAULT_FLAG)], [true, FLAGS[ON_BY_DEFAULT_FLAG].default]);
    world.service.setFeatureFlagOverride(GATED_FLAG, false);
    assert.equal(world.service.checkFeatureGate(GATED_FLAG), false);
    assert.deepEqual(world.service.getFeatureFlagOverridesRecord(), { [GATED_FLAG]: false });
    world.service.clearFeatureFlagOverride(GATED_FLAG);
    assert.equal(world.service.checkFeatureGate(GATED_FLAG), true);
    // A bootstrap that says otherwise loses to the environment, and the bundled value loses to both.
    await world.service.refreshNow();
    assert.deepEqual([world.service.checkFeatureGate(GATED_FLAG), world.service.checkFeatureGate(ON_BY_DEFAULT_FLAG)], [true, true]);
  });

  it("takes the commands a development build can send, and writes them down", async () => {
    const world = serviceWorld({ isDevBuild: true });
    world.service.applyFeatureFlagOverrideCommand({ kind: "set", name: GATED_FLAG, value: true });
    assert.deepEqual(world.service.getFeatureFlagOverridesRecord(), { [GATED_FLAG]: true });
    world.service.applyFeatureFlagOverrideCommand({ kind: "set", name: "not_a_flag", value: true });
    assert.deepEqual(Object.keys(world.service.getFeatureFlagOverridesRecord()), [GATED_FLAG]);
    await waitUntil(() => existsSync(join(world.cacheDir, FEATURE_FLAG_OVERRIDES_FILENAME)));
    const persisted = JSON.parse(readFileSync(join(world.cacheDir, FEATURE_FLAG_OVERRIDES_FILENAME), "utf8")) as { overrides: Record<string, { value: boolean }> };
    assert.deepEqual(persisted.overrides[GATED_FLAG]?.value, true);
    world.service.applyFeatureFlagOverrideCommand({ kind: "clear", name: GATED_FLAG });
    assert.deepEqual(world.service.getFeatureFlagOverridesRecord(), {});
    world.service.applyFeatureFlagOverrideCommand({ kind: "set-all-bundled" });
    assert.deepEqual(Object.keys(world.service.getFeatureFlagOverridesRecord()).length, Object.keys(FLAGS).length);
    world.service.applyFeatureFlagOverrideCommand({ kind: "clear-all" });
    assert.deepEqual([world.service.getFeatureFlagOverridesRecord(), world.service.getFeatureFlagOverrides().size], [{}, 0]);
    const quiet: number[] = [];
    world.service.subscribe(() => quiet.push(1));
    world.service.clearAllFeatureFlagOverrides();
    world.service.clearAllFeatureFlagOverrides();
    assert.deepEqual(quiet.length, 0);
    // A build that may not set them takes none of the single commands, and no panel is shown — but replacing a whole
    // set is the caller's decision to make, so it lands whether or not this build may set them one by one.
    const plain = serviceWorld();
    plain.service.applyFeatureFlagOverrideCommand({ kind: "set", name: GATED_FLAG, value: true });
    assert.deepEqual(plain.service.getFeatureFlagOverridesRecord(), {});
    plain.service.applyFeatureFlagOverrideCommand({ kind: "set-all-bundled" });
    assert.deepEqual(plain.service.getFeatureFlagOverridesRecord(), {});
    plain.service.replaceFeatureFlagOverrides({ [GATED_FLAG]: true });
    assert.deepEqual(plain.service.getFeatureFlagOverridesRecord(), { [GATED_FLAG]: true });
    assert.equal(Object.hasOwn(plain.service.getSnapshot(), "featureFlags"), false);
  });

  it("shows the development panel only where overrides are allowed, and keeps gate properties in step", () => {
    const world = serviceWorld({ isDevBuild: true });
    const property = world.service.getFeatureGateProperty(GATED_FLAG);
    assert.equal(world.service.getFeatureGateProperty(GATED_FLAG), property);
    const values: boolean[] = [];
    property.subscribe((value) => values.push(value));
    assert.deepEqual([property.get(), world.service.getFeatureGateProperty(ON_BY_DEFAULT_FLAG).get()], [FLAGS[GATED_FLAG].default, true]);
    world.service.setFeatureFlagOverride(GATED_FLAG, true);
    assert.deepEqual([property.get(), values], [true, [true]]);
    const panel = world.service.getSnapshot().featureFlags as { items: Array<{ name: string; value: boolean; defaultValue: boolean; override: boolean | null }>; isLive: boolean };
    assert.deepEqual([panel.isLive, panel.items.length], [false, Object.keys(FLAGS).length]);
    const entry = panel.items.find((item) => item.name === GATED_FLAG);
    assert.deepEqual([entry?.value, entry?.defaultValue, entry?.override], [true, FLAGS[GATED_FLAG].default, true]);
    world.service.dispose();
    world.service.setFeatureFlagOverride(GATED_FLAG, false);
    assert.deepEqual(values, [true]);
  });

  it("reads the overrides a development build left on disk, and drops them when it stops being one", async () => {
    // A build that may not use them ignores what is on disk, and one that may has it up from the start.
    const seeded = serviceWorld({ isDevBuild: true, seedOverrides: { [GATED_FLAG]: true } });
    assert.deepEqual([seeded.service.checkFeatureGate(GATED_FLAG), seeded.service.getFeatureFlagOverridesRecord()], [true, { [GATED_FLAG]: true }]);
    const world = serviceWorld();
    writeFileSync(
      join(world.cacheDir, FEATURE_FLAG_OVERRIDES_FILENAME),
      JSON.stringify({ overrides: { [GATED_FLAG]: { value: true, expiresAtMs: Date.now() + 60_000 } } }),
      "utf8",
    );
    assert.deepEqual([world.service.checkFeatureGate(GATED_FLAG), world.service.canUseFeatureFlagOverrides()], [FLAGS[GATED_FLAG].default, false]);
    world.service.setIsInsiderUser(true);
    assert.deepEqual([world.service.canUseFeatureFlagOverrides(), world.service.checkFeatureGate(GATED_FLAG)], [true, true]);
    // On a development build the insider flag changes nothing about what may be set, so nothing is announced.
    const dev = serviceWorld({ isDevBuild: true });
    const announcements: number[] = [];
    dev.service.subscribe(() => announcements.push(1));
    dev.service.setIsInsiderUser(true);
    dev.service.setIsInsiderUser(true);
    assert.deepEqual(announcements.length, 0);
    world.service.setIsInsiderUser(false);
    assert.deepEqual([world.service.canUseFeatureFlagOverrides(), world.service.getFeatureFlagOverridesRecord()], [false, {}]);
  });
});

describe("what the experiment service lets go of", () => {
  it("stops polling, forgets its listeners and closes the client", async () => {
    const world = serviceWorld({ isDevBuild: true, pollIntervalMs: 10 });
    const seen: number[] = [];
    world.service.subscribe(() => seen.push(1));
    await world.service.refreshNow();
    const property = world.service.getFeatureGateProperty(GATED_FLAG);
    const values: boolean[] = [];
    property.subscribe((value) => values.push(value));
    const fetchesBefore = world.bootstrapCalls().length;
    await world.service.dispose();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(world.bootstrapCalls().length, fetchesBefore);
    await world.service.refreshNow();
    assert.equal(world.bootstrapCalls().length, fetchesBefore);
    // The client is gone with it, so gates answer from the bundled values again, while the identity it hydrated with
    // stays known; a waiter that never saw a hydration is let go as false rather than waiting out its deadline.
    assert.equal(world.service.checkFeatureGate(GATED_FLAG), FLAGS[GATED_FLAG].default);
    assert.equal(await world.service.waitForHydratedExperimentUser(5), true);
    const never = serviceWorld();
    const waiting = never.service.waitForHydratedExperimentUser(5_000);
    await never.service.dispose();
    const releasedAt = Date.now();
    assert.equal(await waiting, false);
    assert.equal(Date.now() - releasedAt < 1_000, true);
    // A bootstrap that was still in flight when it was disposed does not land afterwards.
    const gate = deferred<void>();
    const inFlight = serviceWorld({ fetch: async () => {
      await gate.promise;
      return bootstrapResponse(CONFIG);
    } });
    const pending = inFlight.service.refreshNow();
    await waitUntil(() => inFlight.bootstrapCalls().length >= 1);
    await inFlight.service.dispose();
    gate.resolve();
    await pending;
    assert.deepEqual([inFlight.service.hasLiveBootstrap(), inFlight.service.checkFeatureGate(GATED_FLAG)], [false, FLAGS[GATED_FLAG].default]);
    // An override set afterwards is still recorded, but nobody watching hears about it.
    const seenBefore = seen.length;
    world.service.setFeatureFlagOverride(GATED_FLAG, true);
    assert.deepEqual([seen.length, values.length, world.service.getFeatureFlagOverridesRecord()], [seenBefore, 0, { [GATED_FLAG]: true }]);
  });
});
