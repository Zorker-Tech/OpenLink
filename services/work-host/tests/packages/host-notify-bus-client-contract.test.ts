import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HEALTHY_CONNECTION_MIN_LIFETIME_MS,
  SLATE_NOTIFY_TOPIC_FLAGS,
  SLATE_NOTIFY_TOPICS,
  SlateNotifyBusClient,
  SlateNotifyStreamError,
  isSlateNotifyTopic,
  parseNotifyFrame,
} from "../../source/host/extensions/notify-bus/notify-bus-client.ts";
import type { IdleWatchdogPolicy, RetryPolicy } from "../../source/host/extensions/scheduling.ts";

function policy(schedule: RetryPolicy["schedule"] = () => ({ elapsed: Promise.resolve(), dispose() {} })): RetryPolicy {
  return { name: "notify-test-retry", schedule, runWithRetry: async () => { throw new Error("not used by the notify client"); } };
}

function watchdog(onArm?: (onIdle: () => void) => void): IdleWatchdogPolicy & { kicks: number; disposals: number } {
  const state = { kicks: 0, disposals: 0 };
  return {
    name: "notify-test-watchdog",
    arm(onIdle) {
      onArm?.(onIdle);
      return { kick() { state.kicks += 1; }, dispose() { state.disposals += 1; } };
    },
    get kicks() { return state.kicks; },
    get disposals() { return state.disposals; },
  };
}

function clientWorld(options: {
  readonly fetchImpl?: typeof fetch;
  readonly retry?: RetryPolicy;
  readonly watchdog?: IdleWatchdogPolicy;
  readonly getBackendUrl?: () => string;
  readonly getAccessToken?: (args: { backendUrl: string }) => Promise<string>;
  readonly now?: () => number;
  readonly onConnected?: () => void;
} = {}) {
  const fetchCalls: Array<{ url: string; method?: string; headers: Headers; signal?: AbortSignal | null }> = [];
  const tokens: string[] = [];
  const connected: number[] = [];
  const topics: string[] = [];
  const errors: unknown[] = [];
  let nowMs = 1_000;
  const readNow = options.now ?? (() => nowMs);
  const fetchImpl = options.fetchImpl ?? (async (input, init) => {
    fetchCalls.push({
      url: String(input),
      ...(init?.method === undefined ? {} : { method: init.method }),
      headers: new Headers(init?.headers),
      ...(init?.signal === undefined ? {} : { signal: init.signal }),
    });
    return new Response(null, { status: 200 });
  });
  const client = new SlateNotifyBusClient({
    getBackendUrl: options.getBackendUrl ?? (() => "https://backend.example.test/base/path"),
    getAccessToken: options.getAccessToken ?? (async ({ backendUrl }) => { tokens.push(backendUrl); return "access-token"; }),
    onConnected: () => { connected.push(readNow()); options.onConnected?.(); },
    onNotify: (topic) => { topics.push(topic); },
    onStreamError: (error) => { errors.push(error); },
    reconnectBackoff: options.retry ?? policy(),
    stallWatchdog: options.watchdog ?? watchdog(),
    fetchImpl,
    now: readNow,
  });
  return {
    client,
    fetchCalls,
    tokens,
    connected,
    topics,
    errors,
    setNow(value: number) { nowMs = value; },
  };
}

function responseWithChunks(chunks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status });
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("notify-bus condition did not settle");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("the notify bus client contract", () => {
  it("publishes the three supported topics and its healthy-connection threshold", () => {
    assert.deepEqual(SLATE_NOTIFY_TOPIC_FLAGS, {
      "automation-fires": true,
      "listener-events": true,
      "xuser-events": true,
    });
    assert.deepEqual(SLATE_NOTIFY_TOPICS, ["automation-fires", "listener-events", "xuser-events"]);
    assert.equal(HEALTHY_CONNECTION_MIN_LIFETIME_MS, 30_000);
    assert.deepEqual(SLATE_NOTIFY_TOPICS.map(isSlateNotifyTopic), [true, true, true]);
    assert.deepEqual([isSlateNotifyTopic("unknown"), isSlateNotifyTopic(null), isSlateNotifyTopic(1)], [false, false, false]);
  });

  it("accepts only connected or known-topic notify frames and takes the final data line", () => {
    assert.deepEqual(parseNotifyFrame("event: notify\n\n"), { kind: "ignored" });
    assert.deepEqual(parseNotifyFrame("data: {broken}\n\n"), { kind: "ignored" });
    assert.deepEqual(parseNotifyFrame('data: {"kind":"connected"}\n\n'), { kind: "connected" });
    assert.deepEqual(parseNotifyFrame('data: {"kind":"notify","topic":"unknown"}\n\n'), { kind: "ignored" });
    assert.deepEqual(parseNotifyFrame('data: {"kind":"notify","topic":"automation-fires"}\n\n'), {
      kind: "notify", topic: "automation-fires",
    });
    assert.deepEqual(parseNotifyFrame('data: {"kind":"ignored"}\ndata: {"kind":"notify","topic":"xuser-events"}\n\n'), {
      kind: "notify", topic: "xuser-events",
    });
    assert.deepEqual(parseNotifyFrame('data: ["not","a","record"]\n\n'), { kind: "ignored" });
  });

  it("keeps the HTTP failure status on the stream error", () => {
    const error = new SlateNotifyStreamError(503);
    assert.deepEqual([error.name, error.status, error.message], ["SlateNotifyStreamError", 503, "slate notify stream failed: 503"]);
  });

  it("fetches the Slate endpoint with a token and parses frames across chunk boundaries", async () => {
    const frameText = [
      'data: {"kind":"connected"}\n\n',
      'data: {"kind":"notify","topic":"listener-events"}\n\n',
      'data: {"kind":"notify","topic":"not-a-topic"}\n\n',
      "event: comment\n\n",
    ].join("");
    const bytes = new TextEncoder().encode(frameText);
    const chunks = [bytes.slice(0, 9), bytes.slice(9, 45), bytes.slice(45)];
    const seen: Array<{ url: string; headers: Headers; signal?: AbortSignal | null }> = [];
    const world = clientWorld({
      fetchImpl: async (input, init) => {
        seen.push({
          url: String(input),
          headers: new Headers(init?.headers),
          ...(init?.signal === undefined ? {} : { signal: init.signal }),
        });
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
        }), { status: 200 });
      },
    });
    await world.client.streamOnce(new AbortController().signal);
    assert.deepEqual(world.tokens, ["https://backend.example.test/base/path"]);
    assert.equal(seen[0]?.url, "https://backend.example.test/slate/notify");
    assert.equal(seen[0]?.headers.get("authorization"), "Bearer access-token");
    assert.equal(seen[0]?.headers.get("accept"), "text/event-stream");
    assert.deepEqual(world.connected, [1_000]);
    assert.deepEqual(world.topics, ["listener-events"]);
    assert.equal(world.client.isConnected(), true);
  });

  it("arms, kicks for chunks and disposes the idle watchdog after a stream ends", async () => {
    const watchdogPolicy = watchdog();
    const world = clientWorld({
      watchdog: watchdogPolicy,
      fetchImpl: async () => responseWithChunks([
        'data: {"kind":"connected"}\n\n',
        'data: {"kind":"notify","topic":"xuser-events"}\n\n',
      ]),
    });
    await world.client.streamOnce(new AbortController().signal);
    assert.deepEqual([watchdogPolicy.kicks, watchdogPolicy.disposals], [2, 1]);
  });

  it("returns before fetching if the caller has already stopped", async () => {
    const fetchCalls: string[] = [];
    const world = clientWorld({
      fetchImpl: async (input) => { fetchCalls.push(String(input)); return responseWithChunks([]); },
    });
    const stop = new AbortController();
    stop.abort(new Error("stop"));
    await world.client.streamOnce(stop.signal);
    assert.deepEqual(world.tokens, ["https://backend.example.test/base/path"]);
    assert.deepEqual(fetchCalls, []);
  });

  it("raises the stream error for non-OK responses and absent response bodies", async () => {
    const unavailable = clientWorld({ fetchImpl: async () => new Response(null, { status: 503 }) });
    await assert.rejects(() => unavailable.client.streamOnce(new AbortController().signal), (error: unknown) =>
      error instanceof SlateNotifyStreamError && error.status === 503,
    );
    const missingBody = clientWorld({ fetchImpl: async () => ({ ok: true, status: 200, body: null } as Response) });
    await assert.rejects(() => missingBody.client.streamOnce(new AbortController().signal), (error: unknown) =>
      error instanceof SlateNotifyStreamError && error.status === 200,
    );
  });

  it("starts once, increases retry attempts after failure and disposes the active wait on stop", async () => {
    const attempts: number[] = [];
    let disposed = 0;
    const scheduled = Promise.withResolvers<void>();
    const retry = policy((attempt, signal) => {
      attempts.push(attempt);
      if (attempt === 1) return { elapsed: Promise.resolve(), dispose() { disposed += 1; } };
      scheduled.resolve();
      return {
        elapsed: new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })),
        dispose() { disposed += 1; },
      };
    });
    let fetches = 0;
    const world = clientWorld({
      retry,
      fetchImpl: async () => { fetches += 1; throw new Error("offline"); },
    });
    world.client.start();
    world.client.start();
    await scheduled.promise;
    assert.deepEqual([fetches, attempts, world.errors.length], [2, [1, 2], 2]);
    world.client.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(disposed, 2);
    assert.equal(world.client.isConnected(), false);
  });

  it("resets reconnect attempts after a connection lives for the healthy interval", async () => {
    const attempts: number[] = [];
    let fetches = 0;
    let now = 1_000;
    const retry = policy((attempt) => {
      attempts.push(attempt);
      return { elapsed: Promise.resolve(), dispose() {} };
    });
    const secondFetch = Promise.withResolvers<void>();
    const world = clientWorld({
      retry,
      now: () => now,
      onConnected: () => { now += HEALTHY_CONNECTION_MIN_LIFETIME_MS; },
      fetchImpl: async (_input, init) => {
        fetches += 1;
        if (fetches === 1) return responseWithChunks(['data: {"kind":"connected"}\n\n']);
        secondFetch.resolve();
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
      },
    });
    world.client.start();
    await secondFetch.promise;
    assert.deepEqual([fetches, attempts], [2, []]);
    world.client.stop();
    assert.equal(world.client.isConnected(), false);
  });

  it("stop aborts an active request and clears connection state", async () => {
    const firstRead = Promise.withResolvers<void>();
    const world = clientWorld({
      fetchImpl: async (_input, init) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"kind":"connected"}\n\n'));
          firstRead.resolve();
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
        },
      }), { status: 200 }),
    });
    world.client.start();
    await firstRead.promise;
    await waitFor(() => world.client.isConnected());
    world.client.stop();
    assert.equal(world.client.isConnected(), false);
  });
});
