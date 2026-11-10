/**
 * The inference, as the host extension declares it: what it says, when it is ready, the port it builds with its own
 * notification, who hears that the experiment was applied, and the two web tools it delegates.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAgentPromptSession, inferenceExtension } from "../../source/host/extensions/inference/extension.ts";

function extensionWorld(options: { credential?: string | null; mock?: string | undefined } = {}) {
  const applied: (() => void)[] = [];
  const delegated: { search: unknown[]; fetch: unknown[] } = { search: [], fetch: [] };
  const sessions: { onRequestId: unknown; options: unknown }[] = [];
  const port = {
    resolvePrivacyMode: () => "privacy",
    createSession: (onRequestId: (requestId: string) => void, sessionOptions?: Readonly<Record<string, unknown>>) => {
      sessions.push({ onRequestId, options: sessionOptions });
      return { getModelId: () => "model-1", getExecutor: () => ({}) };
    },
  };
  const context = {
    deps: {
      auth: { getAccessToken: async () => "token", getMachineId: () => "machine-1", peekAccessToken: () => options.credential ?? null },
      experiments: {} as never,
      settings: {} as never,
    },
    createPort: (onApplied: () => void) => {
      applied.push(onApplied);
      return port;
    },
    createWebSearch: (args: unknown) => {
      delegated.search.push(args);
      return { answer: "searched" };
    },
    createWebFetch: (args: unknown) => {
      delegated.fetch.push(args);
      return { content: "fetched" };
    },
  };
  return { context, applied, delegated, sessions, port, previousMock: process.env["SLATE_AGENT_MOCK_RESPONSE"], givenMock: options.mock };
}

describe("the inference extension", () => {
  it("says what it is, and builds its port with the callback that tells the host", async () => {
    const world = extensionWorld();
    assert.equal(inferenceExtension.id, "inference");
    assert.deepEqual(inferenceExtension.dependencies, ["auth", "experiments", "settings"]);
    const started = inferenceExtension.start(world.context as never);
    // The port the host asked for is handed back as it was made, built over the extension's own notification.
    assert.equal(started.port, world.port);
    assert.deepEqual(world.applied.length, 1);
    assert.equal(typeof world.applied[0], "function");
    // The two web tools are the host's own, handed their arguments untouched.
    assert.deepEqual([started.createWebSearch({ searchTerm: "x" }), started.createWebFetch({ url: "https://x.test" })], [{ answer: "searched" }, { content: "fetched" }]);
    assert.deepEqual([world.delegated.search, world.delegated.fetch], [[{ searchTerm: "x" }], [{ url: "https://x.test" }]]);
  });

  it("is ready for a mock response with nobody signed in, and for a credential otherwise", async () => {
    const signedOut = extensionWorld({ credential: null });
    assert.equal(await inferenceExtension.start(signedOut.context as never).isReady(), false);
    const signedIn = extensionWorld({ credential: "token" });
    assert.equal(await inferenceExtension.start(signedIn.context as never).isReady(), true);
    // A host that was handed a mock response runs without anyone signing in.
    const mock = extensionWorld({ credential: null });
    process.env["SLATE_AGENT_MOCK_RESPONSE"] = '{"sendMessage":"hi"}';
    try {
      assert.equal(await inferenceExtension.start(mock.context as never).isReady(), true);
    } finally {
      delete process.env["SLATE_AGENT_MOCK_RESPONSE"];
    }
  });

  it("tells whoever asked that the experiment was applied, and lets them stop listening", () => {
    const world = extensionWorld();
    const started = inferenceExtension.start(world.context as never);
    const heard: string[] = [];
    const stopFirst = started.onModelExperimentApplied(() => heard.push("first"));
    started.onModelExperimentApplied(() => heard.push("second"));
    // The notification is the one the port was built with: a listener that stopped is not told again.
    world.applied[0]!();
    assert.deepEqual(heard, ["first", "second"]);
    stopFirst();
    world.applied[0]!();
    assert.deepEqual(heard, ["first", "second", "second"]);
    // A listener that stops listening while the notification is running does not disturb the others, and one that
    // starts listening during a notification hears the next one rather than this one.
    const during: string[] = [];
    const stopDuring = started.onModelExperimentApplied(() => {
      during.push("first");
      stopDuring();
      started.onModelExperimentApplied(() => during.push("late"));
    });
    started.onModelExperimentApplied(() => during.push("second"));
    world.applied[0]!();
    assert.deepEqual(during, ["first", "second"]);
    world.applied[0]!();
    assert.deepEqual(during, ["first", "second", "second", "late"]);
  });

  it("hands a caller a session from the owner it was given, with everything passed through", () => {
    const world = extensionWorld();
    const started = inferenceExtension.start(world.context as never);
    const requestIds: string[] = [];
    const options = { isSummarizationSession: false };
    const session = createAgentPromptSession(started.port, (requestId) => void requestIds.push(requestId), options);
    assert.deepEqual([session.getModelId(), typeof session.getExecutor], ["model-1", "function"]);
    assert.deepEqual(world.sessions, [{ onRequestId: world.sessions[0]!.onRequestId, options }]);
    (world.sessions[0]!.onRequestId as (requestId: string) => void)("r-1");
    assert.deepEqual(requestIds, ["r-1"]);
    // The owner is the port itself: what it knows about privacy is the caller's to ask.
    assert.equal((started.port as { resolvePrivacyMode(): unknown }).resolvePrivacyMode(), "privacy");
  });
});
