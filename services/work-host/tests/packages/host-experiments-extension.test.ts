/**
 * The experiments host extension: what it declares it needs, the service it brings up over the host's own data
 * directory and keeps in step with account renewals and settings, the gate names it answers for the host, and what
 * stopping it lets go of.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { experimentsExtension } from "../../source/host/extensions/experiments/extension.ts";
import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";
import { SLATE_DATA_ROOT_ENV } from "../../source/host/host-paths.ts";
import { BOOTSTRAP_CACHE_FILENAME } from "../../source/shared/node/experiments/slate-experiment-bootstrap.ts";
import { pinExperimentsDiagnosticsReporter, type ExperimentDiagnostic } from "../../source/shared/node/experiments/experiments-diagnostics.ts";
import { SLATE_MODEL_EXPERIMENT_NAME } from "../../source/shared/node/experiments/slate-model-experiment.ts";
import { DYNAMIC_CONFIGS } from "../../source/shared/node/experiments/experiment-config.gen.ts";

type Call = { name: string; args: unknown[] };

const CONFIG = JSON.stringify({
  user: { userID: "user-1" },
  feature_gates: { slate_agent_network: { value: true } },
  dynamic_configs: { slate_default_model: { value: { modelId: "gpt-5.6-luna", maxMode: false, parameters: [] } } },
  experiments: { [SLATE_MODEL_EXPERIMENT_NAME]: { value: { enabled: true }, group_name: "treatment" } },
});

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

function setEnv(name: string, value: string | undefined) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restores.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

/** The host context the extension starts over, with auth and settings the test drives. */
function hostWorld(options: { packaged?: boolean; devDetail?: boolean; token?: string | null; fetch?: (url: string, init: RequestInit) => Promise<Response> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "slate-experiments-ext-"));
  setEnv(SLATE_DATA_ROOT_ENV, root);
  setEnv("SLATE_PACKAGED", options.packaged === true ? "1" : undefined);
  setEnv("SLATE_HOST_DEV_ERROR_DETAIL", options.devDetail === true ? "1" : undefined);
  setEnv("SLATE_MULTITASK", undefined);
  setEnv("SLATE_SPOTLIGHT", undefined);
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const fetchCalls: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push(String(url));
    if (options.fetch != null) return await options.fetch(String(url), init ?? {});
    return new Response(JSON.stringify({ config: CONFIG }), { status: 200 });
  }) as typeof fetch;
  restores.push(() => {
    globalThis.fetch = previousFetch;
  });
  const diagnostics: ExperimentDiagnostic[] = [];
  pinExperimentsDiagnosticsReporter((diagnostic) => diagnostics.push(diagnostic));
  diagnostics.length = 0;
  restores.push(() => pinExperimentsDiagnosticsReporter(null));
  const renewals: Array<(event: { outcome: string; isFirstCredential: boolean }) => void> = [];
  const overrideListeners: Array<(overrides: Record<string, boolean>) => void> = [];
  const deps = {
    [HostExtensions.Auth]: {
      getAccessToken: async () => "token-1",
      getMachineId: async () => "machine-1",
      peekAccessToken: () => (options.token === undefined ? "token-1" : options.token),
      subscribeToRenewal: (listener: (event: { outcome: string; isFirstCredential: boolean }) => void) => {
        renewals.push(listener);
        return () => record("renewal-unsubscribed");
      },
    },
    [HostExtensions.Settings]: {
      subscribeToFeatureFlagOverrides: (listener: (overrides: Record<string, boolean>) => void) => {
        overrideListeners.push(listener);
        return () => record("overrides-unsubscribed");
      },
    },
  };
  const teardowns: Array<() => void | Promise<void>> = [];
  const api = experimentsExtension.start({
    deps: deps as never,
    host: { events: { emit: async (topic: string, payload: unknown) => record("emit", topic, payload) } },
    onStop: (teardown: () => void | Promise<void>) => teardowns.push(teardown),
  } as never) as unknown as {
    checkFeatureGate(name: string): boolean;
    checkGate(name: string, options?: { timeoutMs?: number }): Promise<boolean>;
    getDynamicConfig(name: string): Record<string, unknown>;
    subscribe(listener: (snapshot: unknown) => void): () => void;
    hasHydratedExperimentUser(): boolean;
    hasAuthenticatedBootstrap(): boolean;
    waitForHydratedExperimentUser(timeoutMs?: number): Promise<boolean>;
    getSlateModelExperimentState(): unknown;
    logSlateModelExperimentExposure(): boolean;
    getConfiguredDefaultModel(): unknown;
    getComputerUseModelOverride(): unknown;
    isAgentNetworkEnabled(): boolean;
    isMcpMultiAccountEnabled(): boolean;
    isSparsePluginClonesEnabled(): boolean;
    isMultitaskEnabled(): boolean;
    isSendMessageDeliveryOwedEnabled(): boolean;
    isDynamicToolsEnabled(): boolean;
    isBrowserUseSubagentEnabled(): boolean;
    isSpotlightEnabled(): boolean;
    isUnicodeTypingEnabled(): boolean;
    isUaTokenKillSwitchEnabled(): boolean;
    pinGateOnAuthenticatedBootstrap(name: string, pin: (value: boolean) => void): void;
  };
  // A world a test leaves behind must not keep reporting into the next one's diagnostics.
  restores.push(() => {
    for (const teardown of teardowns) void teardown();
  });
  const resolved = () => diagnostics.filter((diagnostic) => diagnostic.kind === "bootstrap_resolved");
  return {
    api,
    root,
    calls,
    fetchCalls,
    diagnostics,
    renewals,
    overrideListeners,
    teardowns,
    named: (name: string) => calls.filter((call) => call.name === name),
    resolved,
    /** Waits until the service has nothing of its own in flight any more. */
    async settled(): Promise<void> {
      await waitUntil(() => resolved().some((diagnostic) => diagnostic.stage === "startup"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
}

describe("the experiments host extension", () => {
  it("declares itself as the experiments extension and what it needs to start", () => {
    assert.deepEqual([experimentsExtension.id, experimentsExtension.kind], [HostExtensions.Experiments, "host-extension"]);
    assert.deepEqual(experimentsExtension.dependencies, [HostExtensions.Auth, HostExtensions.Settings]);
  });

  it("brings the service up over the host's own data directory and starts it", async () => {
    const world = hostWorld();
    // An account that already has a token is refreshed with the auth change as the reason, after the startup poll.
    await waitUntil(() => world.resolved().some((diagnostic) => diagnostic.stage === "auth_change"));
    assert.deepEqual(world.resolved().map((diagnostic) => diagnostic.stage).slice(-2), ["startup", "auth_change"]);
    // Starting polls straight away, and the bootstrap it brought back is cached under the host's root.
    assert.equal(existsSync(join(world.root, BOOTSTRAP_CACHE_FILENAME)), true);
    assert.equal(await world.api.waitForHydratedExperimentUser(500), true);
  });

  it("answers the host's questions from the one service it brought up", async () => {
    const world = hostWorld();
    await world.settled();
    const snapshots: unknown[] = [];
    const unsubscribe = world.api.subscribe((snapshot) => snapshots.push(snapshot));
    assert.equal(typeof unsubscribe, "function");
    world.overrideListeners[0]?.({ mcp_multi_account: true });
    assert.equal(snapshots.length >= 1, true);
    assert.deepEqual([world.api.hasHydratedExperimentUser(), world.api.hasAuthenticatedBootstrap()], [true, true]);
    assert.equal(await world.api.checkGate("slate_browser_use_subagent"), false);
    // The gate the bootstrap turned on, and the one the settings surface just sent, are both on — through the plain
    // and the waiting question alike.
    assert.deepEqual([world.api.checkFeatureGate("slate_agent_network"), await world.api.checkGate("slate_agent_network")], [true, true]);
    assert.deepEqual([world.api.checkFeatureGate("mcp_multi_account"), await world.api.checkGate("mcp_multi_account")], [true, true]);
    assert.deepEqual(world.api.getConfiguredDefaultModel(), { modelId: "gpt-5.6-luna", maxMode: false, parameters: [] });
    assert.deepEqual(world.api.getSlateModelExperimentState(), { active: true, arm: "treatment" });
    assert.equal(world.api.logSlateModelExperimentExposure(), true);
    assert.deepEqual(world.api.getDynamicConfig("slate_default_model"), { modelId: "gpt-5.6-luna", maxMode: false, parameters: [] });
    // A gate that is pinned waits for the authenticated bootstrap, which has already landed here.
    const pinned: boolean[] = [];
    world.api.pinGateOnAuthenticatedBootstrap("slate_browser_use_subagent", (value) => pinned.push(value));
    assert.deepEqual(pinned, [false]);
    // Its gate is on by default, so the override answers with the config's bundled value.
    assert.deepEqual(world.api.getComputerUseModelOverride(), DYNAMIC_CONFIGS.slate_computer_use_playwright_config.fallbackValues);
  });

  it("names every gate the host asks about", async () => {
    const world = hostWorld();
    await world.settled();
    const helpers: Array<[string, string, () => boolean]> = [
      ["isAgentNetworkEnabled", "slate_agent_network", () => world.api.isAgentNetworkEnabled()],
      ["isMcpMultiAccountEnabled", "mcp_multi_account", () => world.api.isMcpMultiAccountEnabled()],
      ["isSparsePluginClonesEnabled", "enable_sparse_plugin_clones", () => world.api.isSparsePluginClonesEnabled()],
      ["isMultitaskEnabled", "slate_multitask", () => world.api.isMultitaskEnabled()],
      ["isSendMessageDeliveryOwedEnabled", "slate_send_message_delivery_owed", () => world.api.isSendMessageDeliveryOwedEnabled()],
      ["isDynamicToolsEnabled", "slate_dynamic_tools", () => world.api.isDynamicToolsEnabled()],
      ["isBrowserUseSubagentEnabled", "slate_browser_use_subagent", () => world.api.isBrowserUseSubagentEnabled()],
      ["isSpotlightEnabled", "slate_spotlight", () => world.api.isSpotlightEnabled()],
      ["isUnicodeTypingEnabled", "slate_computer_use_unicode_typing", () => world.api.isUnicodeTypingEnabled()],
      ["isUaTokenKillSwitchEnabled", "slate_browser_ua_token_kill_switch", () => world.api.isUaTokenKillSwitchEnabled()],
    ];
    assert.equal(world.overrideListeners.length, 1);
    const baseline = helpers.map(([, , read]) => read());
    for (const [name, flag, read] of helpers) {
      world.overrideListeners[0]?.({ [flag]: true });
      // The helper for that flag is on, and no other helper moved.
      assert.equal(read(), true, name);
      helpers.forEach(([, , other], index) => {
        if (other !== read) assert.equal(other(), baseline[index], `${name} moved another gate`);
      });
    }
    // The two that also honour an environment override take it over the gate.
    world.overrideListeners[0]?.({ slate_multitask: true, slate_spotlight: true });
    setEnv("SLATE_MULTITASK", "0");
    setEnv("SLATE_SPOTLIGHT", "false");
    assert.deepEqual([world.api.isMultitaskEnabled(), world.api.isSpotlightEnabled()], [false, false]);
  });

  it("keeps in step with account renewals, and only when it needs to", async () => {
    const world = hostWorld({ token: null });
    await world.settled();
    const before = world.resolved().length;
    const renew = world.renewals[0];
    assert.notEqual(renew, undefined);
    // A renewal that brought the first credential is worth a refresh.
    renew?.({ outcome: "renewed", isFirstCredential: true });
    await waitUntil(() => world.resolved().length > before);
    assert.equal(world.resolved().length, before + 1);
    assert.equal(world.api.hasAuthenticatedBootstrap(), true);
    // Once an authenticated bootstrap is in hand, a renewal that is not the first is not.
    const settled = world.resolved().length;
    renew?.({ outcome: "renewed", isFirstCredential: false });
    renew?.({ outcome: "failed", isFirstCredential: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(world.resolved().length, settled);
    // An anonymous bootstrap means the next renewal is worth a refresh again.
    const anonymous = hostWorld({ token: null, fetch: async () => new Response(JSON.stringify({ config: JSON.stringify({ feature_gates: {} }) }), { status: 200 }) });
    await anonymous.settled();
    const anonymousSettled = anonymous.resolved().length;
    anonymous.renewals[0]?.({ outcome: "renewed", isFirstCredential: false });
    await waitUntil(() => anonymous.resolved().length > anonymousSettled);
    assert.equal(anonymous.resolved().length, anonymousSettled + 1);
  });

  it("is a development build unless it is packaged, and lets the service go when the host stops it", async () => {
    // A packaged build that is not a development one has no flag overrides to show.
    const packaged = hostWorld({ packaged: true });
    await packaged.settled();
    let packagedSnapshot: Record<string, unknown> = {};
    packaged.api.subscribe((snapshot) => {
      packagedSnapshot = snapshot as Record<string, unknown>;
    });
    packaged.overrideListeners[0]?.({ slate_browser_use_subagent: true });
    assert.equal(Object.hasOwn(packagedSnapshot, "featureFlags"), false);
    assert.equal(packaged.api.isBrowserUseSubagentEnabled(), true);
    // A packaged build that asks for development error detail still is one.
    const detailed = hostWorld({ packaged: true, devDetail: true });
    await detailed.settled();
    let detailedSnapshot: Record<string, unknown> = {};
    detailed.api.subscribe((snapshot) => {
      detailedSnapshot = snapshot as Record<string, unknown>;
    });
    detailed.overrideListeners[0]?.({ slate_browser_use_subagent: true });
    assert.equal(Object.hasOwn(detailedSnapshot, "featureFlags"), true);

    // Stopping it disposes the service and unsubscribes from both surfaces.
    const world = hostWorld();
    await world.settled();
    assert.equal(world.teardowns.length, 3);
    for (const teardown of world.teardowns) await teardown();
    assert.deepEqual([world.named("renewal-unsubscribed").length, world.named("overrides-unsubscribed").length], [1, 1]);
    const fetchesAfterStop = world.fetchCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(world.fetchCalls.length, fetchesAfterStop);
    assert.deepEqual([world.api.checkFeatureGate("slate_browser_use_subagent"), world.api.isAgentNetworkEnabled()], [false, false]);
    assert.deepEqual([world.api.hasHydratedExperimentUser(), world.api.hasAuthenticatedBootstrap()], [true, false]);
  });
});
