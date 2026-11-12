import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { BotRuntimeStore, type BotRuntimeBinding } from "../../source/host/bot/bot-runtime-store.ts";
import { createSubstrateBotBoxProvider } from "../../source/host/bot/bot-box-provider.ts";
import { createBotRuntimeGatewayWithProvider } from "../../source/host/bot/bot-runtime-gateway.ts";
import type { BotBoxProvider } from "../../source/host/bot/bot-box-provider.ts";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const BOT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";

function binding(): BotRuntimeBinding {
  return {
    version: 1,
    agentId: AGENT_ID,
    botId: BOT_ID,
    boxKey: `bot-${BOT_ID}`,
    projectId: PROJECT_ID,
    userId: "user",
    workspaceId: "workspace",
    workerUrl: "http://worker.example",
    workerHeaders: { Authorization: "Bearer worker-token" },
    desktopUrl: "http://desktop.example/vnc.html",
    vncUrl: "http://desktop.example/vnc.html",
    sandboxId: "sandbox-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const runtimeConfiguration = {
  providerId: "deepseek",
  modelId: "deepseek-v4-flash",
  apiKey: "provider-key",
  baseUrl: "https://api.deepseek.com",
  revision: "revision",
};

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("the Bot runtime gateway", () => {
  it("validates the ensure arguments and returns only the desktop capability", async () => {
    const provider: BotBoxProvider = {
      ensure: async (input) => ({
        boxKey: `bot-${input.botId}`,
        sandboxId: "sandbox-1",
        desktopUrl: "http://desktop.example/vnc.html",
        vncUrl: "http://desktop.example/vnc.html",
      }),
      status: async () => ({ state: "absent", binding: null }),
      desktop: async () => ({ boxKey: "", sandboxId: null, desktopUrl: "", vncUrl: "" }),
      release: async () => false,
      readBinding: () => null,
    };
    const gateway = createBotRuntimeGatewayWithProvider(provider);
    const result = await gateway.ensure({
      agentId: AGENT_ID,
      botId: BOT_ID,
      projectId: PROJECT_ID,
      userId: "user",
      workspaceId: "workspace",
      runtimeConfiguration,
    });
    assert.deepEqual(result, {
      ok: true,
      boxKey: `bot-${BOT_ID}`,
      sandboxId: "sandbox-1",
      desktopUrl: "http://desktop.example/vnc.html",
      vncUrl: "http://desktop.example/vnc.html",
    });
    await assert.rejects(
      gateway.ensure({ agentId: AGENT_ID, botId: BOT_ID }),
      /projectId is invalid/,
    );
    assert.deepEqual(await gateway.status({ agentId: AGENT_ID }), { ok: true, state: "absent" });
    assert.deepEqual(await gateway.release({ agentId: AGENT_ID }), { ok: true, released: false });
  });

  it("answers a waiting worker dialog through the Bot binding", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const gateway = createBotRuntimeGatewayWithProvider({
      ensure: async () => ({ boxKey: "", sandboxId: null, desktopUrl: "", vncUrl: "" }),
      status: async () => ({ state: "running", binding: binding() }),
      desktop: async () => ({ boxKey: "", sandboxId: null, desktopUrl: "", vncUrl: "" }),
      release: async () => true,
      readBinding: () => binding(),
    });
    assert.deepEqual(await gateway.status({ agentId: AGENT_ID }), {
      ok: true,
      state: "running",
      boxKey: `bot-${BOT_ID}`,
      sandboxId: "sandbox-1",
      desktopUrl: "http://desktop.example/vnc.html",
      vncUrl: "http://desktop.example/vnc.html",
    });
    await gateway.respondExtensionUi({ agentId: AGENT_ID, id: "dialog-1", confirmed: true });
    assert.equal(requests[0]!.url, "http://worker.example/v1/extension-ui-response");
    assert.deepEqual(requests[0]!.body, { id: "dialog-1", confirmed: true });
  });
});

describe("the substrate Bot box provider", () => {
  it("persists the binding on ensure, reports it, and removes it on release", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "work-host-bot-provider-"));
    context.after(async () => { await rm(root, { recursive: true, force: true }) });
    const previousUrl = process.env.OPENLINK_AGENT_HOST_URL;
    const previousToken = process.env.OPENLINK_SUBSTRATE_API_TOKEN;
    process.env.OPENLINK_AGENT_HOST_URL = "http://substrate.example";
    process.env.OPENLINK_SUBSTRATE_API_TOKEN = "substrate-token";
    context.after(() => {
      if (previousUrl === undefined) delete process.env.OPENLINK_AGENT_HOST_URL;
      else process.env.OPENLINK_AGENT_HOST_URL = previousUrl;
      if (previousToken === undefined) delete process.env.OPENLINK_SUBSTRATE_API_TOKEN;
      else process.env.OPENLINK_SUBSTRATE_API_TOKEN = previousToken;
    });
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      if (init?.method === "DELETE") return new Response(JSON.stringify({ ok: true, released: true }), { status: 200 });
      return new Response(JSON.stringify({
        ok: true,
        boxKey: `bot-${BOT_ID}`,
        sandboxId: "sandbox-1",
        workerUrl: "http://worker.example",
        workerHeaders: { Authorization: "Bearer worker-token" },
        desktopUrl: "http://desktop.example/vnc.html",
        vncUrl: "http://desktop.example/vnc.html",
      }), { status: 200 });
    }) as typeof fetch;

    const store = new BotRuntimeStore(root);
    const provider = createSubstrateBotBoxProvider(store);
    const endpoint = await provider.ensure({
      agentId: AGENT_ID,
      botId: BOT_ID,
      projectId: PROJECT_ID,
      userId: "user",
      workspaceId: "workspace",
      runtimeConfiguration,
    });
    assert.equal(endpoint.boxKey, `bot-${BOT_ID}`);
    assert.equal(calls[0]!.url, `http://substrate.example/v1/substrate/bots/bot-${BOT_ID}/ensure`);
    assert.equal(store.read(AGENT_ID)?.workerUrl, "http://worker.example");
    assert.equal((await provider.status(AGENT_ID)).state, "running");
    assert.equal(await provider.release(AGENT_ID), true);
    assert.equal(calls.at(-1)?.method, "DELETE");
    assert.equal(store.read(AGENT_ID), null);
    assert.equal(await provider.release(AGENT_ID), false);
  });
});
