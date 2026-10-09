/**
 * The inference a host offers: which provider a turn runs on, what is written down when a routed model reports what it
 * spent, and the experiment that tells the host it was applied.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createHostInference, GEMINI_VIDEO_DEVELOPER_API_GATE, usageCountsFrom, wrapExecutorWithUsageRecording, type HostInferenceOptions } from "../../source/host/extensions/inference/inference-service.ts";
import { SLATE_DEFAULT_MODEL_ID } from "../../source/shared/agents/agent-model.ts";
import { SlateSettingsStore } from "../../source/shared/node/settings/slate-settings-store.ts";
import type { PromptExecutor } from "../../source/host/extensions/inference/slate-labeling.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-inference-service-"));
const previousRoot = process.env["SLATE_DATA_ROOT"];
const platformRoot = join(scratch, "root");
process.env["SLATE_DATA_ROOT"] = platformRoot;
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env["SLATE_DATA_ROOT"];
  else process.env["SLATE_DATA_ROOT"] = previousRoot;
});

/** The executor a session hands out, answering with whatever the test says. */
function fakeExecutor(options: { extendedUsage?: unknown; streamResult?: Record<string, unknown> } = {}) {
  const calls: string[] = [];
  const executor = {
    appendMessages: () => void calls.push("append"),
    getState: () => ({ state: "held" }),
    getMessages: () => [{ role: "user" }],
    clearMessages: () => void calls.push("clear"),
    stream: () => {
      calls.push("stream");
      // The answer the test gave is the one handed back — the wrapper may not replace it.
      if (options.extendedUsage !== undefined) return { ...options.streamResult, extendedUsage: options.extendedUsage };
      return options.streamResult ?? {};
    },
  } as unknown as PromptExecutor;
  return { executor, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("what a routed model spent", () => {
  it("writes down the counts it reported, and only those", async () => {
    const recorded: unknown[] = [];
    const { executor } = fakeExecutor({ extendedUsage: Promise.resolve({ inputTokens: 10, outputTokens: 20, cacheReadTokens: "not a number", cacheWriteTokens: 4, extra: 99 }) });
    const wrapped = wrapExecutorWithUsageRecording(executor, "openrouter", (_provider, usage) => void recorded.push(usage));
    assert.deepEqual(usageCountsFrom({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }), { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
    assert.deepEqual([usageCountsFrom({}), usageCountsFrom({ inputTokens: undefined, outputTokens: "2" })], [{}, {}]);
    wrapped.stream("ctx", "invocation");
    await flush();
    assert.deepEqual(recorded, [{ inputTokens: 10, outputTokens: 20, cacheWriteTokens: 4 }]);
  });

  it("hands the stream's own answer back untouched, forwards the rest, and never fails over a usage", async () => {
    const streamResult = { response: "an answer" };
    const { executor, calls } = fakeExecutor({ streamResult });
    const wrapped = wrapExecutorWithUsageRecording(executor, "codex", () => {});
    assert.equal(wrapped.stream(), streamResult);
    assert.deepEqual(wrapped.getState(), { state: "held" });
    assert.deepEqual(wrapped.getMessages(), [{ role: "user" }]);
    wrapped.appendMessages({ role: "user", content: "hi" });
    wrapped.clearMessages();
    assert.deepEqual([calls[0], calls[1], calls[2]], ["stream", "append", "clear"]);
    // Nothing reported is nothing written down.
    const quiet: unknown[] = [];
    const nothing = wrapExecutorWithUsageRecording(fakeExecutor().executor, "codex", (_provider, usage) => void quiet.push(usage));
    nothing.stream();
    await flush();
    assert.deepEqual(quiet, []);
    // A usage that arrived as a value rather than a promise is written down no differently.
    const value: unknown[] = [];
    wrapExecutorWithUsageRecording(fakeExecutor({ extendedUsage: { inputTokens: 1 } }).executor, "codex", (_provider, usage) => void value.push(usage)).stream();
    await flush();
    assert.deepEqual(value, []);
    // A usage that could not be written down is swallowed.
    const failing = wrapExecutorWithUsageRecording(fakeExecutor({ extendedUsage: Promise.reject(new Error("the ledger is down")) }).executor, "codex", () => { throw new Error("the settings store is read-only"); });
    failing.stream();
    await flush();
  });
});

describe("the inference a host offers", () => {
  function hostWorld(provider: string) {
    // The service reads the provider where the coordinator keeps it: the platform's own settings file.
    new SlateSettingsStore(join(platformRoot, "settings.json")).setInferenceProvider(provider as never);
    const applied: string[] = [];
    const recorded: { provider: string; usage: unknown }[] = [];
    const options = {
      auth: { getAccessToken: async () => "token", getMachineId: () => "machine" },
      experiments: {
        checkFeatureGate: (name: string) => name === GEMINI_VIDEO_DEVELOPER_API_GATE,
        getComputerUseModelOverride: () => undefined,
        getBrowserUseModelOverride: () => undefined,
        getSlateModelExperimentState: () => null,
        hasHydratedStatsigUserId: () => true,
        getConfiguredDefaultModel: () => undefined,
        getConfiguredAutomationsModel: () => undefined,
      },
      settings: {
        getAgentDefaultModel: () => undefined,
        getComputerUseModel: () => undefined,
        getInferenceProvider: () => provider as never,
        recordInferenceUsage: (given: string, usage: unknown) => void recorded.push({ provider: given, usage }),
      },
      onModelExperimentApplied: () => void applied.push("applied"),
    } as unknown as HostInferenceOptions;
    return { options, applied, recorded, inference: createHostInference(options) };
  }

  it("runs a turn on the provider the coordinator recorded, and the platform's own when it chose that", async () => {
    // A provider that is not the platform's own is handed its own session.
    const routed = hostWorld("openrouter");
    const session = routed.inference.createSession(() => {});
    assert.equal(typeof session.getModelId(), "string");
    assert.equal(session.getModelId() === SLATE_DEFAULT_MODEL_ID, false);
    // The platform's own provider gets the platform's own session, whose experiment was read on the way.
    const own = hostWorld("slate");
    const backend = own.inference.createSession(() => {});
    assert.equal(typeof backend.getModelId(), "string");
    assert.deepEqual(own.applied, ["applied"]);
    assert.deepEqual(routed.applied, []);
    // A summarization session exists for either provider, and is a session of its own.
    const summary = own.inference.createSummarizationSession(() => {});
    assert.equal(typeof summary.getExecutor, "function");
    const routedSummary = routed.inference.createSummarizationSession(() => {});
    assert.equal(typeof routedSummary.getExecutor, "function");
    // The rest of the offered inference is the session factory's own.
    assert.equal(typeof routed.inference.resolvePrivacyMode, "function");
    assert.equal(typeof routed.inference.recordPostTurnLabeling, "function");
  });

  it("tells the host the experiment was applied only once the account's stats are hydrated", async () => {
    const notHydrated = hostWorld("slate");
    (notHydrated.options.experiments as { hasHydratedStatsigUserId: () => boolean }).hasHydratedStatsigUserId = () => false;
    notHydrated.inference.createSession(() => {});
    // The state can be read either way; being told it was applied waits for the account's own stats to be there.
    assert.deepEqual(notHydrated.applied, []);
    const hydrated = hostWorld("slate");
    hydrated.inference.createSession(() => {});
    assert.deepEqual(hydrated.applied, ["applied"]);
  });

  it("takes the platform's video gate for what it is", async () => {
    const world = hostWorld("slate");
    // The gate the service asks is the platform's own, and it is asked per session rather than once.
    assert.equal(GEMINI_VIDEO_DEVELOPER_API_GATE, "gemini_video_developer_api");
    assert.equal(world.options.experiments.checkFeatureGate(GEMINI_VIDEO_DEVELOPER_API_GATE), true);
    assert.equal(world.options.experiments.checkFeatureGate("something_else"), false);
  });

  it("wraps the platform's own session's executor, and writes nothing down for one that reported nothing", async () => {
    const world = hostWorld("slate");
    const session = world.inference.createSession(() => {});
    const executor = session.getExecutor() as { getState?: () => unknown; getMessages?: () => unknown; appendMessages?: unknown; clearMessages?: unknown; stream?: unknown };
    // The executor a session hands out is the wrapped one: every method of it is there, answering rather than throwing.
    assert.deepEqual(
      [typeof executor.getState, typeof executor.getMessages, typeof executor.appendMessages, typeof executor.clearMessages, typeof executor.stream],
      ["function", "function", "function", "function", "function"],
    );
    assert.equal(typeof session.getModelId(), "string");
    // Nothing was reported, so nothing was written down.
    await flush();
    assert.deepEqual(world.recorded, []);
  });
});
