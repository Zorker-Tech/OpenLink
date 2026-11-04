/**
 * The coordinator's own inference routing: the store it keeps, what a surface reads out of it, the transcript a caller
 * asks for, reactions, and a turn run by another provider — including one that failed and one that had to wait.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createCoordinatorInferenceRouter, parseInferenceRouterTranscriptStore, projectInferenceRouterTranscriptEntry, type StoredEntry } from "../../source/coordinator/inference-router.ts";
import { SlateSettingsStore } from "../../source/shared/node/settings/slate-settings-store.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-inference-router-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const entry = (overrides: Partial<StoredEntry> = {}): StoredEntry => ({ provider: "codex", role: "user", content: "hi", id: "t0u", timestampMs: 1, ...overrides });

describe("the store this coordinator keeps", () => {
  it("keeps the entries that say what they are, and drops the ones that do not", () => {
    const parsed = parseInferenceRouterTranscriptStore({
      schemaVersion: 2,
      agents: {
        "agent-1": [
          { provider: "codex", role: "user", content: "hi", id: "t0u", timestampMs: 1, clientNonce: "n", richText: "**hi**", reactions: [{ emoji: "thumbs", by: "me" }] },
          { provider: "claude-code", role: "assistant", content: "yo", id: "t0s0", timestampMs: 2 },
          { provider: "slate", role: "user", content: "no", id: "t1u", timestampMs: 3 },
          { provider: "codex", role: "system", content: "no", id: "t2u", timestampMs: 4 },
          { provider: "codex", role: "user", content: 5, id: "t3u", timestampMs: 5 },
          { provider: "codex", role: "user", content: "no", id: 6, timestampMs: 6 },
          { provider: "codex", role: "user", content: "no", id: "t4u", timestampMs: "7" },
          { provider: "codex", role: "user", content: "no", id: "t5u", timestampMs: 8, clientNonce: 9 },
          { provider: "codex", role: "user", content: "no", id: "t6u", timestampMs: 8, richText: 9 },
          { provider: "codex", role: "user", content: "no", id: "t7u", timestampMs: 8, reactions: [{ emoji: "x" }] },
          { provider: "codex", role: "user", content: "no", id: "t8u", timestampMs: 8, reactions: "no" },
          "not an object",
        ],
        "agent-2": "not a list",
      },
    });
    // An agent whose entries are not a list at all is not an agent this store knows.
    assert.deepEqual(Object.keys(parsed.agents), ["agent-1"]);
    assert.deepEqual(parsed.agents["agent-1"]!.map((stored) => stored.id), ["t0u", "t0s0"]);
    // Everything else is not this store at all, even when it holds entries that look like this store's.
    const lookalike = { schemaVersion: 1, agents: { "agent-1": [{ provider: "codex", role: "user", content: "hi", id: "t0u", timestampMs: 1 }] } };
    assert.deepEqual(
      [parseInferenceRouterTranscriptStore(null), parseInferenceRouterTranscriptStore({}), parseInferenceRouterTranscriptStore({ schemaVersion: 1, agents: {} }), parseInferenceRouterTranscriptStore(lookalike), parseInferenceRouterTranscriptStore({ schemaVersion: "2", agents: {} }), parseInferenceRouterTranscriptStore({ schemaVersion: 2, agents: [] })],
      [{ schemaVersion: 2, agents: {} }, { schemaVersion: 2, agents: {} }, { schemaVersion: 2, agents: {} }, { schemaVersion: 2, agents: {} }, { schemaVersion: 2, agents: {} }, { schemaVersion: 2, agents: {} }],
    );
    // A store that somehow grew past its bound keeps the most recent entries.
    const many = parseInferenceRouterTranscriptStore({ schemaVersion: 2, agents: { "agent-1": Array.from({ length: 205 }, (_unused, index) => ({ provider: "codex", role: "user", content: String(index), id: `t${index}u`, timestampMs: index })) } });
    assert.deepEqual([many.agents["agent-1"]!.length, many.agents["agent-1"]![0]!.content], [200, "5"]);
  });

  it("projects an entry the way a surface reads it", () => {
    assert.deepEqual(projectInferenceRouterTranscriptEntry(entry({ richText: "**hi**", clientNonce: "n", reactions: [{ emoji: "e", by: "me" }] })), {
      kind: "message",
      id: "t0u",
      role: "user",
      content: "hi",
      richText: "**hi**",
      isStreaming: false,
      timestampMs: 1,
      clientNonce: "n",
      reactions: [{ emoji: "e", by: "me" }],
    });
    assert.deepEqual(projectInferenceRouterTranscriptEntry(entry({ role: "assistant", id: "t0s0" })), { kind: "send-message", id: "t0s0", message: { type: "text", content: "hi" }, timestampMs: 1 });
  });
});

function routerWorld(options: { provider?: string; remote?: unknown; agents?: readonly { id: string }[]; tools?: readonly unknown[]; runText?: (provider: string, messages: readonly unknown[], options?: Record<string, unknown>) => Promise<string> } = {}) {
  const dataDir = mkdtempSync(join(scratch, "router-"));
  if (options.provider !== undefined) new SlateSettingsStore(join(dataDir, "settings.json")).setInferenceProvider(options.provider as never);
  const events: { family: string; payload: unknown }[] = [];
  const calls: { method: string; args: unknown }[] = [];
  const router = createCoordinatorInferenceRouter({
    dataDir,
    postEvent: (family, payload) => void events.push({ family, payload }),
    dispatchRemote: async (method, args) => {
      calls.push({ method, args });
      if (method === "listAgents") return options.agents ?? [];
      if (method === "listRoutedMcpTools") return options.tools ?? [];
      return options.remote ?? {};
    },
    ...(options.runText === undefined ? {} : { runText: options.runText as never }),
  });
  const store = () => {
    try {
      return JSON.parse(readFileSync(join(dataDir, "inference-router-transcript.json"), "utf8")) as { agents: Record<string, StoredEntry[]> };
    } catch {
      return { agents: {} };
    }
  };
  const seed = (agents: Record<string, StoredEntry[]>) => writeFileSync(join(dataDir, "inference-router-transcript.json"), JSON.stringify({ schemaVersion: 2, agents }));
  const transcripts = () => events.filter((event) => event.family === "transcript").map((event) => event.payload as { type: string; entry: Record<string, unknown>; agentId: string });
  return { dataDir, router, events, calls, store, seed, transcripts };
}

describe("what the router answers", () => {
  it("says which provider the account chose, and leaves methods it does not own alone", async () => {
    assert.equal(routerWorld().router.provider(), "slate");
    assert.equal(routerWorld({ provider: "codex" }).router.provider(), "codex");
    assert.deepEqual(await routerWorld().router.dispatch("somethingElse", {}), { handled: false });
    assert.deepEqual(await routerWorld({ provider: "slate" }).router.dispatch("sendPrompt", { agentId: "a", prompt: "p" }), { handled: false });
  });

  it("toggles a reaction on an entry, and lets the last one go", async () => {
    const world = routerWorld();
    world.seed({ "agent-1": [entry({ id: "t0u" })] });
    assert.deepEqual(await world.router.dispatch("reactToMessage", { agentId: "agent-1", entryId: "t0u", emoji: "  thumbs  " }), { handled: true, value: undefined });
    assert.deepEqual(world.store().agents["agent-1"]![0]!.reactions, [{ emoji: "thumbs", by: "me" }]);
    assert.deepEqual(world.transcripts(), [{ type: "updated", entry: { kind: "message", id: "t0u", role: "user", content: "hi", isStreaming: false, timestampMs: 1, reactions: [{ emoji: "thumbs", by: "me" }] }, agentId: "agent-1" }]);
    // Reacting with the same emoji again takes it back, and the entry is stored as one that never had any.
    await world.router.dispatch("reactToMessage", { agentId: "agent-1", entryId: "t0u", emoji: "thumbs" });
    assert.equal("reactions" in world.store().agents["agent-1"]![0]!, false);
    // Nothing to react to is not this method's business.
    for (const args of [{ agentId: "", entryId: "t0u", emoji: "x" }, { agentId: "agent-1", entryId: "", emoji: "x" }, { agentId: "agent-1", entryId: "t0u", emoji: "   " }, { agentId: "agent-1", entryId: "nope", emoji: "x" }, { agentId: "other", entryId: "t0u", emoji: "x" }]) {
      assert.deepEqual(await world.router.dispatch("reactToMessage", args), { handled: false });
    }
  });

  it("answers a transcript read with the backend's tail and this store's turns after it", async () => {
    const local = [entry({ id: "t2u", content: "local" })];
    const world = routerWorld({ provider: "codex", remote: { entries: [{ id: "t0u" }, { id: "t1s0" }], hasMore: false } });
    world.seed({ "agent-1": local });
    const answered = await world.router.dispatch("getAgentTranscriptTail", { id: "agent-1" });
    assert.deepEqual(answered, { handled: true, value: { entries: [{ id: "t0u" }, { id: "t1s0" }, { kind: "message", id: "t2u", role: "user", content: "local", isStreaming: false, timestampMs: 1 }], hasMore: false } });
    assert.deepEqual(world.calls, [{ method: "getAgentTranscriptTail", args: { id: "agent-1" } }]);
    // The limit is the caller's when it makes sense, and this store's own when it does not.
    const limited = await routerWorld({ provider: "codex", remote: { entries: [{ id: "t0u" }, { id: "t1u" }] } }).router.dispatch("openAgentTail", { id: "agent-1", limit: 1 });
    assert.deepEqual((limited.value as { entries: unknown[] }).entries, [{ id: "t1u" }]);
    const unlimited = await routerWorld({ provider: "codex", remote: { entries: [{ id: "t0u" }] } }).router.dispatch("openAgentTail", { id: "a", limit: 0 });
    assert.deepEqual((unlimited.value as { entries: unknown[] }).entries, [{ id: "t0u" }]);
    // A read that answered with something else is passed through, not merged.
    assert.deepEqual(await routerWorld({ provider: "codex", remote: "not a result" }).router.dispatch("openAgentTail", { id: "a" }), { handled: true, value: "not a result" });
    assert.deepEqual(await routerWorld({ provider: "codex", remote: { entries: [] } }).router.dispatch("openAgentTail", {}), { handled: true, value: { entries: [] } });
    // The platform's own provider has its own transcript, and this router keeps out of it.
    assert.deepEqual(await routerWorld({ provider: "slate" }).router.dispatch("getAgentTranscriptTail", { id: "a" }), { handled: false });
  });
});

describe("a turn run by another provider", () => {
  it("writes the user's turn, runs it, and writes the answer back with a turn number of its own", async () => {
    const world = routerWorld({
      provider: "codex",
      remote: { entries: [{ id: "t4u" }, { id: "t3s0" }] },
      agents: [{ id: "agent-1" }, { id: "agent-2" }],
      runText: async (_provider, _messages, runOptions) => {
        // A provider that streams says what it has so far before it is done.
        (runOptions as { onTextDelta: (delta: string, accumulated: string) => void }).onTextDelta("the an", "the an");
        (runOptions as { onTextDelta: (delta: string, accumulated: string) => void }).onTextDelta("swer", "the answer");
        return "the answer";
      },
    });
    world.seed({ "agent-1": [entry({ id: "t2u" })] });
    assert.deepEqual(await world.router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "do it", richText: "**do it**", clientNonce: "n-1" }), { handled: true, value: { accepted: true, clientNonce: "n-1", provider: "codex" } });
    await waitFor(() => {
      const savedAnswer = (world.store().agents["agent-1"]?.length ?? 0) >= 3;
      const finalTranscriptUpdate = world.transcripts().some(
        (event) => event.entry["id"] === "t5s0" && event.entry["streaming"] === false,
      );
      return savedAnswer && finalTranscriptUpdate;
    });
    const stored = world.store().agents["agent-1"]!;
    // The turn after the highest either side knows: the backend had t4, so this one is t5.
    assert.deepEqual(stored.map((entry) => [entry.id, entry.role, entry.content]), [["t2u", "user", "hi"], ["t5u", "user", "do it"], ["t5s0", "assistant", "the answer"]]);
    assert.deepEqual(stored[1]!.clientNonce, "n-1");
    assert.deepEqual([...new Set(world.transcripts().map((event) => `${event.type}:${event.entry["id"]}`))], ["appended:t5u", "appended:t5s0", "updated:t5s0"]);
    // What streamed is what was said, and the last word on it is not streaming any more.
    const streamed = world.transcripts().filter((event) => event.entry["id"] === "t5s0");
    assert.deepEqual(streamed.map((event) => [(event.entry as { streaming?: boolean }).streaming, (event.entry as { message: { content: string } }).message.content]), [[true, "the an"], [true, "the answer"], [false, "the answer"]]);
    // The composing state is published while the turn runs and taken back when it settles.
    const activity = world.events.filter((event) => event.family === "agents").map((event) => (event.payload as { agents: { isRunning?: boolean }[] }).agents[0]!.isRunning);
    assert.deepEqual([activity[0], activity.at(-1)], [true, false]);
    // A turn of the platform's own provider is not run here.
    assert.deepEqual(await routerWorld({ provider: "slate" }).router.dispatch("sendPrompt", { agentId: "a", prompt: "p" }), { handled: false });
  });

  it("runs one turn at a time for an agent, and writes a failure down as the answer", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const held = () => new Promise<void>((resolve) => void (release = resolve));
    const world = routerWorld({
      provider: "openrouter",
      runText: async (_provider, messages) => {
        const prompt = (messages.at(-1) as { content: string }).content;
        order.push(`start:${prompt}`);
        if (prompt === "first") await held();
        order.push(`end:${prompt}`);
        return `answer to ${prompt}`;
      },
    });
    await world.router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "first" });
    await waitFor(() => order.length === 1);
    await world.router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "second" });
    // The second turn waits: it does not even start until the first one ended.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.deepEqual(order, ["start:first"]);
    release?.();
    await waitFor(() => order.length === 4, 6_000);
    assert.deepEqual(order, ["start:first", "end:first", "start:second", "end:second"]);
  });

  it("answers a turn that failed with what failed, and keeps the turn the user sent", async () => {
    const world = routerWorld({ provider: "codex", runText: async () => { throw new Error("the provider is down"); } });
    await world.router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "do it" });
    await waitFor(() => world.store().agents["agent-1"]?.length === 2);
    const stored = world.store().agents["agent-1"]!;
    assert.deepEqual([stored[0]!.role, stored[0]!.content], ["user", "do it"]);
    assert.deepEqual([stored[1]!.role, stored[1]!.content], ["assistant", "Router error: the provider is down"]);
    // A turn with nothing to run says so, and nothing is written for it.
    const empty = routerWorld({ provider: "codex", runText: async () => "answer" });
    assert.deepEqual(await empty.router.dispatch("sendPrompt", { agentId: "", prompt: "p" }), { handled: true, value: { accepted: true, clientNonce: undefined, provider: "codex" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(empty.store().agents[""], undefined);
  });
});

/** Waits for the store to catch up with a turn that runs in the background. */
async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("the store did not catch up");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
