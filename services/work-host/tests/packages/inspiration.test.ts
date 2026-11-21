import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import type { BotRuntimeBinding } from "../../source/host/bot/bot-runtime-store.ts";
import {
  isDuplicateTitle,
  InspirationRuntime,
} from "../../source/host/inspiration/inspiration-runtime.ts";
import {
  parseInspirationCandidates,
  parseInspirationGate,
} from "../../source/host/inspiration/inspiration-divergence.ts";
import {
  advanceOutOfQuietHours,
  inspirationPriority,
  isQuietHour,
  poissonDelay,
} from "../../source/host/inspiration/inspiration-scheduler.ts";
import {
  InspirationStore,
  defaultInspirationState,
  normalizeInspirationConfig,
} from "../../source/host/inspiration/inspiration-store.ts";
import { inspirationDayKey } from "../../source/host/inspiration/inspiration-scheduler.ts";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function binding(): BotRuntimeBinding {
  return {
    version: 1,
    agentId: AGENT_ID,
    botId: "22222222-2222-4222-8222-222222222222",
    boxKey: "bot-22222222-2222-4222-8222-222222222222",
    projectId: "33333333-3333-4333-8333-333333333333",
    userId: "user",
    workspaceId: "workspace",
    workerUrl: "http://worker.example",
    workerHeaders: { Authorization: "Bearer worker-token" },
    desktopUrl: "http://desktop.example",
    vncUrl: "http://desktop.example",
    sandboxId: "sandbox-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openlink-inspiration-"));
  const agentDir = join(root, AGENT_ID);
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "profile.json"), JSON.stringify({
    name: "star",
    description: "A careful project Bot",
    title: "",
    instructions: "Watch for reliability problems and explain them briefly.",
    inspirationBudgetUsd: null,
  }));
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const tm = {
    sessions: {
      activeSession: null,
      resolveBackgroundSession: async (agentId: string) => ({
        id: agentId,
        dbPath: join(agentDir, "db.sqlite"),
        db: {
          getTranscriptEntries: () => [
            { id: "u1", kind: "message", role: "user", content: "Please watch the deploy", timestampMs: 1 },
            { id: "a1", kind: "message", role: "assistant", content: "I will check the deploy pipeline", timestampMs: 2 },
          ],
        },
      }),
    },
    runnerRegistry: {
      getRunner: () => ({
        run: async (prompt: string, options: Record<string, unknown>) => {
          calls.push({ prompt, options });
          return { text: "", sentMessageCount: 1, reacted: false, aborted: false };
        },
      }),
    },
    runLifecycle: {
      beginSessionRun: () => {},
      endSessionRun: () => {},
      enqueueExclusiveRun: async (_id: string, work: () => Promise<void>) => { await work(); },
    },
    turnRuntime: { activeRequestSources: new Map() },
    roster: { emitAgentUpdate: async () => {} },
  };
  const store = new InspirationStore(root);
  return { root, agentDir, store, tm, calls };
}

function mockWorker(candidateTitle = "Check the deploy pipeline") {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/inspiration/context")) {
      return Response.json({ workspaceRoot: "/workspace", gitLog: "abc123 init", topLevel: ["README.md"] });
    }
    if (url.endsWith("/v1/inspiration/complete")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { systemPrompt?: string };
      if (String(body.systemPrompt).includes("interruption gate")) {
        return Response.json({ text: JSON.stringify({ selection: 0, reason: "worth a look" }), costUsd: 0.0001, usage: { totalTokens: 20 } });
      }
      return Response.json({
        text: JSON.stringify({
          candidates: [{
            title: candidateTitle,
            whyNow: "The deploy just changed.",
            firstAction: "Read the latest deploy logs.",
            expectedValue: 0.8,
            estimatedCost: 0.2,
            novelty: 0.7,
            lens: "reliability",
          }],
        }),
        costUsd: 0.001,
        usage: { totalTokens: 100 },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("the inspiration subscription", () => {
  it("normalizes unsafe cadence, quiet hours and budgets", () => {
    const config = normalizeInspirationConfig({
      enabled: true,
      cadence: { meanIntervalMs: 1, minIntervalMs: 0, maxIntervalMs: 1, dailyCap: 999, burstChance: 9 },
      quietHours: { startHour: 99, endHour: -4 },
      budgetUsdPerDay: -3,
      lenses: ["security", "security", "not-a-lens"],
      topics: [" deploy ", "deploy"],
    });
    assert.equal(config.enabled, true);
    assert.equal(config.cadence.meanIntervalMs, 15 * 60_000);
    assert.equal(config.cadence.minIntervalMs, 5 * 60_000);
    assert.equal(config.cadence.maxIntervalMs, 15 * 60_000);
    assert.equal(config.cadence.dailyCap, 24);
    assert.equal(config.cadence.burstChance, 0.5);
    assert.deepEqual(config.quietHours, { startHour: 23, endHour: 0 });
    assert.equal(config.budgetUsdPerDay, 0);
    assert.deepEqual(config.lenses, ["security"]);
    assert.deepEqual(config.topics, ["deploy"]);
  });

  it("uses a bounded Poisson delay and respects quiet hours", () => {
    const cadence = { meanIntervalMs: 6 * 60 * 60_000, minIntervalMs: 45 * 60_000, maxIntervalMs: 24 * 60 * 60_000, dailyCap: 3, burstChance: 0 };
    assert.equal(poissonDelay(cadence, () => 0.5), Math.round(-cadence.meanIntervalMs * Math.log(0.5)));
    assert.equal(poissonDelay(cadence, () => 0), cadence.maxIntervalMs);
    assert.equal(poissonDelay(cadence, () => 1), cadence.minIntervalMs);
    const quiet = { startHour: 23, endHour: 8 };
    assert.equal(isQuietHour(Date.UTC(2026, 0, 1, 23, 30), quiet, "UTC"), true);
    assert.equal(isQuietHour(Date.UTC(2026, 0, 1, 12, 0), quiet, "UTC"), false);
    assert.equal(advanceOutOfQuietHours(Date.UTC(2026, 0, 1, 23, 30), quiet, "UTC"), Date.UTC(2026, 0, 2, 8, 0));
    assert.equal(inspirationDayKey(Date.UTC(2026, 0, 1, 23, 30), "UTC"), "2026-01-01");
  });

  it("ranks a clear, engaged, funded Bot above a vague, exhausted one", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0);
    const base = defaultInspirationState(AGENT_ID);
    const due = {
      ...base,
      nextFireAt: now - 2 * 60 * 60_000,
      config: { ...base.config, enabled: true },
    };
    const high = inspirationPriority({
      state: {
        ...due,
        feedback: { useful: 3, notUseful: 0, dismissed: 0 },
        usage: { dayKey: "2026-01-01", usd: 0, tokens: 0, runs: 0 },
      },
      instructions: "Watch reliability and explain it briefly.",
      description: "A careful project Bot",
      budgetUsdPerDay: 5,
      now,
      timeZone: "UTC",
      random: () => 0.5,
    });
    const low = inspirationPriority({
      state: {
        ...due,
        feedback: { useful: 0, notUseful: 3, dismissed: 0 },
        usage: { dayKey: "2026-01-01", usd: 5, tokens: 0, runs: 1 },
      },
      instructions: "",
      description: "",
      budgetUsdPerDay: 5,
      now,
      timeZone: "UTC",
      random: () => 0.5,
    });
    assert.ok(high > low, `expected ${high} > ${low}`);
  });

  it("parses model JSON through fences and detects duplicate ideas", () => {
    const candidates = parseInspirationCandidates(
      "Here you go:\n```json\n{\"candidates\":[{\"title\":\"Check deploy\",\"whyNow\":\"changed\",\"firstAction\":\"read logs\",\"expectedValue\":0.9,\"estimatedCost\":0.1,\"novelty\":0.8,\"lens\":\"reliability\"}]}\n```",
      "random",
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.title, "Check deploy");
    assert.equal(candidates[0]?.lens, "reliability");
    assert.deepEqual(parseInspirationGate('{"selection":0,"reason":"ok"}', 2), { selection: 0, reason: "ok" });
    assert.deepEqual(parseInspirationGate('{"selection":4,"reason":"out of range"}', 2), { selection: null, reason: "out of range" });
    assert.equal(isDuplicateTitle("Check the deploy pipeline", [{
      id: "1",
      createdAt: 1,
      trigger: "stochastic",
      lens: "reliability",
      candidate: { title: "check deploy pipeline", whyNow: "", firstAction: "", expectedValue: 0, estimatedCost: 0, novelty: 0, lens: "reliability" },
      decision: "woke",
      messageCount: 1,
      costUsd: 0,
      tokens: 0,
    }]), true);
    assert.equal(isDuplicateTitle("Write the onboarding guide", []), false);
  });

  it("runs a silent-by-default hidden wake and records the outcome", async () => {
    const { root, store, tm, calls } = await fixture();
    mockWorker();
    const runtime = new InspirationRuntime({
      tm,
      store,
      getBinding: () => binding(),
      now: () => Date.UTC(2026, 0, 1, 12, 0),
      random: () => 0.5,
      timeZone: () => "UTC",
    });
    runtime.configure(AGENT_ID, { enabled: true });
    const result = await runtime.runNow(AGENT_ID);
    assert.equal(result.decision, "woke");
    assert.equal(result.outcome, "acted");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.options.hidden, true);
    assert.equal(calls[0]?.options.isSilenceAllowed, true);
    assert.equal(calls[0]?.options.suppressFinalMessage, true);
    assert.match(calls[0]?.prompt ?? "", /SendMessage/);
    const state = store.read(AGENT_ID);
    assert.equal(state.ledger.at(-1)?.candidate?.title, "Check the deploy pipeline");
    assert.equal(state.usage.runs, 1);
    await rm(root, { recursive: true, force: true });
  });

  it("stops at the daily budget and records the reason", async () => {
    const { root, agentDir, store, tm } = await fixture();
    mockWorker();
    const runtime = new InspirationRuntime({
      tm,
      store,
      getBinding: () => binding(),
      now: () => Date.UTC(2026, 0, 1, 12, 0),
      random: () => 0.5,
      timeZone: () => "UTC",
    });
    await writeFile(join(agentDir, "profile.json"), JSON.stringify({
      name: "star",
      description: "A careful project Bot",
      title: "",
      instructions: "",
      inspirationBudgetUsd: 0.01,
    }));
    const state = defaultInspirationState(AGENT_ID);
    state.config = { ...state.config, enabled: true };
    state.usage = { dayKey: "2026-01-01", usd: 0.02, tokens: 100, runs: 1 };
    store.write(state);
    const result = await runtime.runNow(AGENT_ID);
    assert.equal(result.decision, "budget");
    assert.match(result.detail ?? "", /budget/i);
    await rm(root, { recursive: true, force: true });
  });

  it("queues a sibling nomination and pulls the next fire earlier", async () => {
    const { root, store, tm } = await fixture();
    mockWorker();
    const runtime = new InspirationRuntime({
      tm,
      store,
      getBinding: () => binding(),
      now: () => Date.UTC(2026, 0, 1, 12, 0),
      random: () => 0.5,
      timeZone: () => "UTC",
    });
    runtime.configure(AGENT_ID, { enabled: true });
    const result = runtime.nominate("99999999-9999-4999-8999-999999999999", AGENT_ID, "Check the deploy pipeline");
    assert.deepEqual(result, { ok: true });
    const state = store.read(AGENT_ID);
    assert.equal(state.nominations.length, 1);
    assert.equal(state.nominations[0]?.task, "Check the deploy pipeline");
    assert.ok((state.nextFireAt ?? Infinity) <= Date.UTC(2026, 0, 1, 12, 2));
    await rm(root, { recursive: true, force: true });
  });
});
