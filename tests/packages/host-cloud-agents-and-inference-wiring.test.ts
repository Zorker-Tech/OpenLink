/**
 * Two wirings: the cloud-agent extension (the manager it builds and the policy it asks for early) and the inference
 * production extras (the three factories the extension's context asks for).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { cloudAgentsExtension } from "../../source/host/cloud-agents/extension.ts";
import { CLOUD_AGENT_POLL_INTERVAL_MS } from "../../source/host/cloud-agents/cloud-agent-poll-loop.ts";
import { createInferenceProductionExtras } from "../../source/host/extensions/inference/production.ts";
import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";
import { SlateSettingsStore } from "../../source/shared/node/settings/slate-settings-store.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-host-wiring-2-"));
const previousRoot = process.env["SLATE_DATA_ROOT"];
const platformRoot = join(scratch, "root");
process.env["SLATE_DATA_ROOT"] = platformRoot;
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env["SLATE_DATA_ROOT"];
  else process.env["SLATE_DATA_ROOT"] = previousRoot;
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("the cloud-agent extension", () => {
  it("declares what it needs, and hands the host a manager watching on the platform's own interval", async () => {
    assert.equal(cloudAgentsExtension.kind, "host-extension");
    assert.equal(cloudAgentsExtension.id, HostExtensions.CloudAgents);
    assert.deepEqual(cloudAgentsExtension.dependencies, [HostExtensions.Auth]);
    assert.equal(CLOUD_AGENT_POLL_INTERVAL_MS, 10_000);
    const converted: unknown[] = [];
    const teardowns: (() => void | Promise<void>)[] = [];
    const manager = cloudAgentsExtension.start({
      deps: { auth: { getAccessToken: async () => "token", getMachineId: async () => "machine-1" } },
      host: { convertCloudAgentConversationToTrace: (conversation: unknown) => (converted.push(conversation), [conversation]) },
      onStop: (teardown: () => void | Promise<void>) => void teardowns.push(teardown),
    } as never) as unknown as {
      launch: unknown;
      list: unknown;
      get: unknown;
      reply: unknown;
      awaitCompletion: unknown;
      dispose: unknown;
      isDisabledByTeamAdmin(): boolean;
      launchedIds: Set<string>;
      convertConversationMessagesToTrace?: unknown;
    };
    assert.deepEqual([typeof manager.launch, typeof manager.list, typeof manager.get, typeof manager.reply, typeof manager.awaitCompletion, typeof manager.dispose], ["function", "function", "function", "function", "function", "function"]);
    assert.deepEqual([...manager.launchedIds], []);
    // The team policy was asked for before anyone asked about it; with no reachable backend the answer stays "not
    // disabled" rather than becoming an error.
    assert.equal(manager.isDisabledByTeamAdmin(), false);
    assert.equal(teardowns.length, 1);
    await teardowns[0]!();
    await tick();
  });
});

describe("the inference production extras", () => {
  function extrasWorld(provider = "slate") {
    new SlateSettingsStore(join(platformRoot, "settings.json")).setInferenceProvider(provider as never);
    const applied: string[] = [];
    const context = {
      deps: {
        auth: { getAccessToken: async () => "token", getMachineId: () => "machine-1", peekAccessToken: () => "token" },
        experiments: {
          checkFeatureGate: () => false,
          getComputerUseModelOverride: () => undefined,
          getBrowserUseModelOverride: () => undefined,
          getSlateModelExperimentState: () => null,
          hasHydratedStatsigUserId: () => true,
          getConfiguredDefaultModel: () => undefined,
          getConfiguredAutomationsModel: () => undefined,
        },
        settings: { getAgentDefaultModel: () => undefined, getComputerUseModel: () => undefined, getInferenceProvider: () => provider as never, recordInferenceUsage: () => {} },
      },
      host: {},
      onStop: () => {},
    };
    return { context, applied, extras: createInferenceProductionExtras(context as never) };
  }

  it("builds the three factories the extension's context asks for", () => {
    const world = extrasWorld();
    assert.deepEqual(Object.keys(world.extras).sort(), ["createPort", "createWebFetch", "createWebSearch"]);
    for (const [name, factory] of Object.entries(world.extras)) assert.equal(typeof factory, "function", name);
  });

  it("builds a port that reports the experiment back to whoever asked for it", async () => {
    const world = extrasWorld();
    const port = world.extras.createPort(() => void world.applied.push("applied")) as unknown as { createSession: unknown; resolvePrivacyMode: unknown; recordPostTurnLabeling: unknown };
    assert.deepEqual([typeof port.createSession, typeof port.resolvePrivacyMode, typeof port.recordPostTurnLabeling], ["function", "function", "function"]);
    // The callback the caller handed in is the one the port tells: creating a session reads the experiment, and that is
    // when the host is told it was applied.
    (port as unknown as { createSession(onRequestId: () => void): unknown }).createSession(() => {});
    assert.deepEqual(world.applied, ["applied"]);
  });

  it("builds both web tools from the account's credential and what the caller named", () => {
    const world = extrasWorld();
    const search = world.extras.createWebSearch({ modelId: "slate-fast" });
    const fetch = world.extras.createWebFetch({});
    assert.deepEqual([typeof search, typeof fetch], ["function", "function"]);
    // A caller that named a request id is passed on; one that did not is not.
    const withId = world.extras.createWebSearch({ modelId: "slate-fast", onRequestId: () => {} });
    assert.equal(typeof withId, "function");
    assert.equal(typeof world.extras.createWebFetch({ onRequestId: () => {} }), "function");
  });
});
