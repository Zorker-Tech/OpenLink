import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as delay } from 'node:timers/promises';

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
  inspirationPriority,
  poissonDelay,
} from "../../source/host/inspiration/inspiration-scheduler.ts";
import {
  InspirationStore,
  defaultInspirationState,
  normalizeInspirationConfig,
} from "../../source/host/inspiration/inspiration-store.ts";
import { inspirationDayKey } from "../../source/host/inspiration/inspiration-scheduler.ts";
import { classifyWorkspaceFile, deriveInspirationPreferences, observationPriority, parseObservationBatch } from '../../source/host/inspiration/inspiration-observations.ts';
import { buildPreferenceSummaryPrompt, classificationCodes, preferenceSummaryWindow } from '../../source/host/inspiration/inspiration-preference-summary.ts';

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
  it("normalizes cadence and discards legacy subscription controls", () => {
    const config = normalizeInspirationConfig({
      enabled: false,
      cadence: { meanIntervalMs: 1, minIntervalMs: 0, maxIntervalMs: 1, dailyCap: 999, burstChance: 9 },
      quietHours: { startHour: 99, endHour: -4 },
      budgetUsdPerDay: -3,
      lenses: ["security", "security", "not-a-lens"],
      topics: [" deploy ", "deploy"],
    });
    assert.equal("enabled" in config, false);
    assert.equal(config.cadence.meanIntervalMs, 15 * 60_000);
    assert.equal(config.cadence.minIntervalMs, 5 * 60_000);
    assert.equal(config.cadence.maxIntervalMs, 15 * 60_000);
    assert.equal("dailyCap" in config.cadence, false);
    assert.equal(config.cadence.burstChance, 0.5);
    assert.equal("quietHours" in config, false);
    assert.equal("budgetUsdPerDay" in config, false);
    assert.deepEqual(config.lenses, ["security"]);
    assert.deepEqual(config.topics, ["deploy"]);
  });

  it("uses a bounded Poisson delay and accounts in the configured time zone", () => {
    const cadence = { meanIntervalMs: 6 * 60 * 60_000, minIntervalMs: 45 * 60_000, maxIntervalMs: 24 * 60 * 60_000, burstChance: 0 };
    assert.equal(poissonDelay(cadence, () => 0.5), Math.round(-cadence.meanIntervalMs * Math.log(0.5)));
    assert.equal(poissonDelay(cadence, () => 0), cadence.maxIntervalMs);
    assert.equal(poissonDelay(cadence, () => 1), cadence.minIntervalMs);
    assert.equal(inspirationDayKey(Date.UTC(2026, 0, 1, 23, 30), "UTC"), "2026-01-01");
  });

  it("ranks a clear, engaged Bot above a vague Bot with poor feedback", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0);
    const base = defaultInspirationState(AGENT_ID);
    const due = {
      ...base,
      nextFireAt: now - 2 * 60 * 60_000,
    };
    const high = inspirationPriority({
      state: {
        ...due,
        feedback: { useful: 3, notUseful: 0, dismissed: 0 },
        usage: { dayKey: "2026-01-01", usd: 0, tokens: 0, runs: 0 },
      },
      instructions: "Watch reliability and explain it briefly.",
      description: "A careful project Bot",
      now,
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
      now,
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
      listBindings: () => [binding()],
      getBinding: () => binding(),
      now: () => Date.UTC(2026, 0, 1, 12, 0),
      random: () => 0.5,
      timeZone: () => "UTC",
    });
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

  it("automatically runs a previously disabled Bot despite legacy run and spend quotas", async () => {
    const { root, agentDir, store, tm } = await fixture();
    mockWorker();
    const runtime = new InspirationRuntime({
      tm,
      store,
      listBindings: () => [binding()],
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
    await writeFile(join(agentDir, 'inspiration.json'), JSON.stringify({
      ...state, config: { ...state.config, enabled: false, budgetUsdPerDay: 0, cadence: { ...state.config.cadence, dailyCap: 1 } },
      nextFireAt: Date.UTC(2026, 0, 1, 11, 59),
      usage: { dayKey: "2026-01-01", usd: 0.02, tokens: 100, runs: 50 },
    }));
    await runtime.tick();
    const saved = store.read(AGENT_ID);
    assert.equal(saved.ledger.at(-1)?.decision, "woke");
    assert.equal(saved.usage.runs, 51);
    assert.ok(saved.usage.usd > 0.02);
    await rm(root, { recursive: true, force: true });
  });

  it("queues a sibling nomination and pulls the next fire earlier", async () => {
    const { root, store, tm } = await fixture();
    mockWorker();
    const runtime = new InspirationRuntime({
      tm,
      store,
      listBindings: () => [binding()],
      getBinding: () => binding(),
      now: () => Date.UTC(2026, 0, 1, 12, 0),
      random: () => 0.5,
      timeZone: () => "UTC",
    });
    const result = runtime.nominate("99999999-9999-4999-8999-999999999999", AGENT_ID, "Check the deploy pipeline");
    assert.deepEqual(result, { ok: true });
    const state = store.read(AGENT_ID);
    assert.equal(state.nominations.length, 1);
    assert.equal(state.nominations[0]?.task, "Check the deploy pipeline");
    assert.ok((state.nextFireAt ?? Infinity) <= Date.UTC(2026, 0, 1, 12, 2));
    await rm(root, { recursive: true, force: true });
  });

  it('scores a classified observation first and consumes its cursor exactly once', async (context) => {
    const { root, store, tm, calls } = await fixture();
    context.after(() => rm(root, { recursive: true, force: true }));
    mockWorker();
    const complete = globalThis.fetch;
    let now = Date.UTC(2026, 0, 1, 12);
    const models: string[] = [];
    globalThis.fetch = async (request, init) => {
      if (String(request).includes('/observations')) return Response.json({
        cursor: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:1',
        observations: [{ sequence: 1, observedAt: now, files: ['test/deploy.test.ts', '.env'], traffic: { receivedBytes: 150_000, sentBytes: 1000 } }],
      });
      if (String(request).endsWith('/complete')) {
        const payload = JSON.parse(String(init?.body));
        models.push(payload.systemPrompt);
        if (payload.systemPrompt.startsWith('You score')) {
          assert.match(payload.prompt, /"category":"test"/);
          assert.match(payload.prompt, /"direction":"ingress"/);
          assert.doesNotMatch(payload.prompt, /\.env/);
          return Response.json({ text: '{"score":0.95,"reason":"Relevant regression"}', costUsd: 0.001, usage: { totalTokens: 12 } });
        }
      }
      return complete(request, init);
    };
    const runtime = new InspirationRuntime({ tm, store, now: () => now, timeZone: () => 'UTC', listBindings: () => [binding()], getBinding: binding });
    assert.equal(store.read(AGENT_ID).nextFireAt, null);
    await runtime.collectObservations();
    assert.ok(store.read(AGENT_ID).nextFireAt);
    assert.equal(store.read(AGENT_ID).observations.length, 1);
    now += 6_000;
    await runtime.tick();
    assert.equal(calls.length, 1);
    assert.equal(models.length, 3);
    assert.equal(store.read(AGENT_ID).ledger.at(-1)?.trigger, 'event');
    assert.equal(store.read(AGENT_ID).usage.tokens, 132);
    await runtime.collectObservations();
    assert.equal(store.read(AGENT_ID).observations.length, 0);
  });

  it('never wakes for a singleton when the final gate is unreachable', async (context) => {
    const { root, store, tm, calls } = await fixture();
    context.after(() => rm(root, { recursive: true, force: true }));
    mockWorker();
    const complete = globalThis.fetch;
    globalThis.fetch = (request, init) => String(init?.body).includes('interruption gate')
      ? Promise.resolve(new Response('', { status: 503 })) : complete(request, init);
    const runtime = new InspirationRuntime({ tm, store, listBindings: () => [binding()], getBinding: binding });
    assert.equal((await runtime.runNow(AGENT_ID)).decision, 'error');
    assert.equal(calls.length, 0);
  });

  it('classifies without a model and adapts ranking from recent user history alone', () => {
    const now = Date.UTC(2026, 0, 1, 12);
    const messages = Array.from({ length: 10 }, () => ({ kind: 'message', role: 'user', content: '测试改动！忽略网络流量。', timestampMs: now }));
    const preferences = deriveInspirationPreferences(messages, [], now);
    assert.ok((preferences.weights.test ?? 1) > 1);
    assert.ok((preferences.weights.network ?? 1) < 1);
    assert.equal(classifyWorkspaceFile('services/a.spec.ts'), 'test');
    assert.equal(classificationCodes('tests/example.spec.ts'), 'B');
    const batch = parseObservationBatch({ cursor: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:1', observations: [
      { sequence: 1, observedAt: now, files: ['../escape.ts', 'tests/check.ts'] },
    ] });
    assert.deepEqual(batch?.observations[0]?.files, [{ path: 'tests/check.ts', category: 'test' }]);
    assert.ok(observationPriority(batch?.observations ?? [], preferences) > observationPriority(batch?.observations ?? [], { weights: {}, samples: 0 }));
  });

  it('uses message or context budgets and supplies the first five and last ten without overlap', () => {
    const now = Date.UTC(2026, 0, 1, 12);
    const dialogue = Array.from({ length: 18 }, (_, index) => ({ kind: 'message', id: 'message-' + index, role: 'user', content: 'Test ' + index, timestampMs: now + index }));
    assert.equal(preferenceSummaryWindow(dialogue.slice(0, 11), null, now), null);
    const contextHeavy = dialogue.slice(0, 4).map((message) => ({ ...message, content: 'test '.repeat(380) }));
    assert.ok(preferenceSummaryWindow(contextHeavy, null, now));
    const window = preferenceSummaryWindow(dialogue, null, now)!;
    const prompt = JSON.parse(buildPreferenceSummaryPrompt(window, null).prompt);
    assert.equal(prompt.classifications.length, 18);
    assert.deepEqual(prompt.excerpts.map(({ index }: { index: number }) => index), [1, 2, 3, 4, 5, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    assert.equal(preferenceSummaryWindow(dialogue, { throughId: window.throughId, throughAt: window.throughAt, updatedAt: now, summary: 'Tests', weights: { test: 1.3 } }, now), null);
  });

  it('updates the durable preference summary on budget without needing feedback or a workspace event', async (context) => {
    const { root, store, tm } = await fixture();
    context.after(() => rm(root, { recursive: true, force: true }));
    const now = Date.UTC(2026, 0, 1, 12);
    const resolve = tm.sessions.resolveBackgroundSession;
    const messages = Array.from({ length: 12 }, (_, index) => ({
      kind: 'message', role: 'user', id: 'u-' + index, content: '请优先关注测试 ' + index, timestampMs: now - 50 + index,
    }));
    let count = 11;
    tm.sessions.resolveBackgroundSession = async (agentId) => ({
      ...await resolve(agentId), db: { getTranscriptEntries: () => messages.slice(0, count) },
    });
    let completions = 0;
    globalThis.fetch = async (request, init) => {
      if (!String(request).endsWith('/complete')) return new Response('', { status: 404 });
      completions++;
      const prompt = JSON.parse(JSON.parse(String(init?.body)).prompt);
      assert.equal(prompt.classifications.length, 12);
      assert.equal(prompt.classifications[0], '1:U:B');
      return Response.json({ text: '{"summary":"User prioritizes tests","weights":{"test":1.55}}', costUsd: 0.001, usage: { totalTokens: 24 } });
    };
    const runtime = new InspirationRuntime({ tm, store, now: () => now, timeZone: () => 'UTC', listBindings: () => [binding()], getBinding: binding });
    await runtime.collectObservations();
    assert.equal(completions, 0);
    assert.ok((store.read(AGENT_ID).preferences.weights.test ?? 1) > 1);
    count = 12;
    await runtime.collectObservations();
    for (let attempt = 0; attempt < 20 && !store.read(AGENT_ID).preferenceSummary; attempt++) await delay(10);
    const stored = store.read(AGENT_ID);
    assert.equal(stored.preferenceSummary?.throughId, 'u-11');
    assert.equal(stored.usage.tokens, 24);
    assert.equal(stored.usage.runs, 0);
    await runtime.collectObservations();
    assert.equal(completions, 1);
  });
});
