import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  BotRuntimeStore,
  parseBotRuntimeBinding,
  type BotRuntimeBinding,
} from "../../source/host/bot/bot-runtime-store.ts";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const BOT_ID = "22222222-2222-4222-8222-222222222222";

function binding(overrides: Partial<BotRuntimeBinding> = {}): BotRuntimeBinding {
  return {
    version: 1,
    agentId: AGENT_ID,
    botId: BOT_ID,
    boxKey: `bot-${BOT_ID}`,
    projectId: "33333333-3333-4333-8333-333333333333",
    userId: "user",
    workspaceId: "workspace",
    workerUrl: "http://worker.example/v1",
    workerHeaders: { Authorization: "Bearer worker-token" },
    desktopUrl: "http://desktop.example/vnc.html",
    vncUrl: "http://desktop.example/vnc.html",
    sandboxId: "sandbox-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("the Bot runtime store", () => {
  it("round-trips one binding beside its agent and removes it idempotently", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "work-host-bot-store-"));
    context.after(async () => { await rm(root, { recursive: true, force: true }) });
    const store = new BotRuntimeStore(root);
    const value = binding();
    store.write(value);
    assert.deepEqual(store.read(AGENT_ID), value);
    assert.deepEqual(store.list(), [value]);
    store.remove(AGENT_ID);
    assert.equal(store.read(AGENT_ID), null);
    store.remove(AGENT_ID);
  });

  it("rejects a binding that is missing the identity or worker endpoint", () => {
    assert.equal(parseBotRuntimeBinding({ version: 1, agentId: AGENT_ID }), null);
    assert.equal(parseBotRuntimeBinding({ ...binding(), boxKey: "session-1" }), null);
    assert.equal(parseBotRuntimeBinding({ ...binding(), workerHeaders: { "bad\nheader": "x" } }), null);
    assert.equal(parseBotRuntimeBinding({ ...binding(), agentId: "../escape" }), null);
  });

  it("treats a corrupt file as a recoverable missing binding", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "work-host-bot-store-corrupt-"));
    context.after(async () => { await rm(root, { recursive: true, force: true }) });
    const store = new BotRuntimeStore(root);
    store.write(binding());
    await writeFile(join(root, AGENT_ID, "bot-runtime.json"), "{not json", "utf8");
    assert.equal(store.read(AGENT_ID), null);
  });
});
