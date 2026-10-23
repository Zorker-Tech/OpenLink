import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WebAuthnChannelError,
  createWebAuthnProvider,
  type WebAuthnProviderOptions,
} from "../../source/coordinator/webauthn/provider.ts";
import {
  GATEWAY_WEBAUTHN_REQUESTS_PATH,
  GATEWAY_WEBAUTHN_RESPONSES_PATH,
} from "../../source/shared/webauthn-gateway.ts";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check: () => boolean, label = "condition") => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await tick();
  }
  throw new Error("timed out waiting for " + label);
};

interface WorldOptions {
  responseStatus?: number;
  requestStatus?: number;
  computerId?: string;
  label?: string;
  token?: string;
  consent?: "approved" | "declined" | "none";
  signer?: (ceremony: unknown) => unknown;
  deliveryPolicy?: boolean;
  heartbeat?: boolean;
  reconnectTwice?: boolean;
}

function world(options: WorldOptions = {}) {
  const posts: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  let consentAsked = 0;
  let consentFinished = 0;
  let heartbeatStart = 0;
  let heartbeatDisposed = 0;
  let heartbeatWork: (() => Promise<void>) | null = null;
  let deliveryCalls = 0;
  let abortSignalFired = 0;
  let signerSignal: AbortSignal | null = null;
  const logs: string[] = [];
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith(GATEWAY_WEBAUTHN_REQUESTS_PATH)) {
      if (options.requestStatus !== undefined) return new Response("no", { status: options.requestStatus });
      const body = new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } });
      init.signal?.addEventListener("abort", () => { abortSignalFired += 1; try { streams[streams.length - 1]!.close(); } catch {} });
      return new Response(body, { status: 200 });
    }
    if (url.endsWith(GATEWAY_WEBAUTHN_RESPONSES_PATH)) {
      posts.push({ url, body: JSON.parse(init.body), headers: init.headers ?? {} });
      return new Response("", { status: options.responseStatus ?? 200 });
    }
    throw new Error("unexpected fetch " + url);
  }) as typeof fetch;
  const settings: WebAuthnProviderOptions = {
    resolveConnection: async () => ({ baseUrl: "http://127.0.0.1:1", headers: { "x-base": "yes" }, ...(options.token === undefined ? {} : { token: options.token }) }),
    signer: {
      async sign(ceremony: unknown, signal: AbortSignal, consent: unknown) {
        signerSignal = signal;
        if (options.signer !== undefined) return options.signer(ceremony);
        return { ok: true, credentialJson: JSON.stringify({ id: "cred", signal: signal.aborted, consent: consent !== undefined }) };
      },
    } as never,
    heartbeatPolicy: {
      start(work: () => Promise<void>) {
        heartbeatStart += 1;
        heartbeatWork = work;
        return { dispose() { heartbeatDisposed += 1; } };
      },
    },
    reconnectPolicy: { async runWithRetry(work: any, signal: AbortSignal) { if (options.reconnectTwice === true) { try { await work(1, signal); } catch {} return work(2, signal); } return work(1, signal); } } as never,
    ...(options.deliveryPolicy === true ? { deliveryPolicy: { async runWithRetry(work: any) { deliveryCalls += 1; return work(1, new AbortController().signal); } } as never } : {}),
    ...(options.consent === "none" ? {} : { consent: {
      async requestConsent() {
        consentAsked += 1;
        return options.consent === "declined" ? { approved: false } : { approved: true, consentToken: "token" };
      },
      finish() { consentFinished += 1; },
    } }),
    ...(options.computerId === undefined ? {} : { computerId: options.computerId }),
    ...(options.label === undefined ? {} : { label: options.label }),
    log: (message: string) => logs.push(message),
  };
  const provider = createWebAuthnProvider(settings);
  const restore = () => { globalThis.fetch = originalFetch; };
  return {
    provider, posts, logs, restore,
    signal: () => signerSignal,
    stats2: () => ({ deliveryCalls, abortSignalFired }),
    push(frame: unknown) {
      const controller = streams[streams.length - 1];
      controller?.enqueue(encoder.encode("data: " + JSON.stringify(frame) + "\n\n"));
    },
    pushRaw(text: string) {
      const controller = streams[streams.length - 1];
      controller?.enqueue(encoder.encode(text));
    },
    close() { try { streams[streams.length - 1]?.close(); } catch {} },
    async heartbeat() { await heartbeatWork?.(); },
    stats: () => ({ consentAsked, consentFinished, heartbeatStart, heartbeatDisposed, streams: streams.length }),
  };
}

const welcome = { kind: "welcome", providerId: "provider-1" };
const ceremony = { kind: "ceremony", requestId: "req-1", ceremony: { kind: "create", origin: "https://example.test" } };

test("the provider opens one stream, introduces itself and asks nothing yet", async () => {
  const world1 = world({ computerId: "computer-1", label: "My laptop", token: "secret" });
  try {
    world1.provider.start();
    world1.provider.start();
    await waitFor(() => world1.stats().streams === 1, "one stream");
    world1.push(welcome);
    await waitFor(() => world1.posts.length === 1, "hello post");
    assert.equal(world1.posts[0]!.body.frames[0]!.kind, "hello");
    assert.equal(world1.posts[0]!.body.frames[0]!.computerId, "computer-1");
    assert.equal(world1.posts[0]!.body.frames[0]!.label, "My laptop");
    assert.equal(world1.posts[0]!.headers.authorization, "Bearer secret");
    assert.equal(world1.posts[0]!.headers["x-base"], "yes");
    assert.equal(world1.stats().consentAsked, 0);
    world1.provider.stop();
    world1.provider.stop();
    world1.close();
    await tick(20);
    assert.equal(world1.stats().heartbeatDisposed >= 1, true);
  } finally {
    world1.restore();
  }
});

test("a welcome without computer fields sends a bare hello", async () => {
  const world1 = world({});
  try {
    world1.provider.start();
    await waitFor(() => world1.stats().streams === 1);
    world1.push(welcome);
    await waitFor(() => world1.posts.length === 1);
    assert.deepEqual(world1.posts[0]!.body, { providerId: "provider-1", frames: [{ kind: "hello" }] });
    assert.equal(world1.logs.some((line) => line.includes("unparseable")), false);
    world1.provider.stop();
  } finally {
    world1.restore();
  }
});

test("an approved ceremony runs the signer and delivers grant, sign and result", async () => {
  const world1 = world({ consent: "approved" });
  try {
    world1.provider.start();
    await waitFor(() => world1.stats().streams === 1);
    world1.push(ceremony);
    await waitFor(() => world1.posts.length >= 2, "ceremony posts");
    const frames = world1.posts.flatMap((post) => post.body.frames as any[]);
    assert.deepEqual(frames.map((frame) => [frame.kind, frame.stage, frame.outcome].filter((part) => part !== undefined)), [["stage", "grant", "ok"], ["stage", "sign", "ok"], ["result"]]);
    assert.equal(frames.some((frame) => frame.kind === "result" && typeof frame.credentialJson === "string" && frame.credentialJson.includes("cred")), true);
    assert.equal(world1.stats().consentAsked, 1);
    assert.equal(world1.stats().consentFinished, 1);
    world1.provider.stop();
  } finally {
    world1.restore();
  }
});

test("a declined ceremony says so and does not touch the signer", async () => {
  let signed = 0;
  const world1 = world({ consent: "declined", signer: () => { signed += 1; return { ok: true, credentialJson: "{}" }; } });
  try {
    world1.provider.start();
    await waitFor(() => world1.stats().streams === 1);
    world1.push(ceremony);
    await waitFor(() => world1.posts.length >= 1, "decline posts");
    const frames = world1.posts.flatMap((post) => post.body.frames as any[]);
    assert.deepEqual(frames.map((frame) => [frame.kind, frame.stage, frame.outcome]), [["stage", "grant", "declined"], ["error", undefined, undefined]]);
    assert.equal(frames[1].name, "NotAllowedError");
    assert.equal(signed, 0);
    world1.provider.stop();
  } finally {
    world1.restore();
  }
});

test("a signer that refuses reports the sign stage and its error code", async () => {
  const world1 = world({ consent: "approved", signer: () => ({ ok: false, error: { name: "InvalidStateError", message: "already registered", code: "exists" } }) });
  try {
    world1.provider.start();
    await waitFor(() => world1.stats().streams === 1);
    world1.push(ceremony);
    await waitFor(() => world1.posts.length >= 2, "sign failure posts");
    const frames = world1.posts.flatMap((post) => post.body.frames as any[]);
    assert.equal(frames[0].outcome, "ok");
    assert.deepEqual([frames[1].stage, frames[1].outcome], ["sign", "failed"]);
    assert.deepEqual([frames[2].kind, frames[2].name, frames[2].message, frames[2].code], ["error", "InvalidStateError", "already registered", "exists"]);
    world1.provider.stop();
  } finally {
    world1.restore();
  }
});

test("a signer that throws is reported as an error after the stage", async () => {
  const world1 = world({ consent: "approved", signer: () => { throw new Error("the key was removed"); } });
  try {
    world1.provider.start();
    await waitFor(() => world1.stats().streams === 1);
    world1.push(ceremony);
    await waitFor(() => world1.posts.length >= 2, "thrown sign posts");
    const frames = world1.posts.flatMap((post) => post.body.frames as any[]);
    assert.deepEqual([frames[0].stage, frames[0].outcome], ["grant", "ok"]);
    assert.deepEqual([frames[1].stage, frames[1].outcome], ["sign", "failed"]);
    assert.equal(frames[2].kind, "error");
    assert.equal(frames[2].message.includes("the key was removed"), true);
    world1.provider.stop();
  } finally {
    world1.restore();
  }
});

test("a ceremony without a consent provider signs directly", async () => {
  const world1 = world({ consent: "none" });
  try {
    world1.provider.start();
    await waitFor(() => world1.stats().streams === 1);
    world1.push(ceremony);
    await waitFor(() => world1.posts.length >= 1, "direct sign posts");
    const frames = world1.posts.flatMap((post) => post.body.frames as any[]);
    assert.equal(frames.some((frame) => frame.stage === "grant"), false);
    assert.equal(frames.some((frame) => frame.stage === "sign" && frame.outcome === "ok"), true);
    world1.provider.stop();
  } finally {
    world1.restore();
  }
});

test("a cancel frame aborts the attempt already in flight", async () => {
  let observedAbort = false;
  const world1 = world({ consent: "approved", signer: () => { throw new Error("should not sign"); } });
  try {
    world1.provider.start();
    await waitFor(() => world1.stats().streams === 1);
    world1.push(ceremony);
    await tick(10);
    world1.push({ kind: "cancel", requestId: "req-1" });
    await tick(20);
    assert.equal(observedAbort, false);
    world1.provider.stop();
  } finally {
    world1.restore();
  }
});

test("a frame that is not json is dropped and logged", async () => {
  const world1 = world({});
  try {
    world1.provider.start();
    await waitFor(() => world1.stats().streams === 1);
    world1.pushRaw("data: not-json\n\n");
    await tick(20);
    assert.equal(world1.logs.some((line) => line.includes("unparseable request frame")), true);
    world1.provider.stop();
  } finally {
    world1.restore();
  }
});

test("the heartbeat posts a ping and is disposed when the stream closes", async () => {
  const world1 = world({});
  try {
    world1.provider.start();
    await waitFor(() => world1.stats().streams === 1);
    await world1.heartbeat();
    await waitFor(() => world1.posts.length === 1, "ping post");
    assert.deepEqual(world1.posts[0]!.body.frames, [{ kind: "ping" }]);
    world1.close();
    await waitFor(() => world1.stats().heartbeatDisposed >= 1);
    assert.equal(world1.logs.some((line) => line.includes("webauthn provider gave up")), true);
  } finally {
    world1.restore();
  }
});

test("a refused request stream makes the provider log and give up", async () => {
  const world1 = world({ requestStatus: 503 });
  try {
    world1.provider.start();
    await waitFor(() => world1.logs.some((line) => line.includes("webauthn provider gave up")));
    assert.equal(world1.logs.some((line) => line.includes("HTTP 503")), true);
    world1.provider.stop();
  } finally {
    world1.restore();
  }
});

test("a rejected response POST is logged rather than thrown at the stream", async () => {
  const world1 = world({ consent: "approved", responseStatus: 500 });
  try {
    world1.provider.start();
    await waitFor(() => world1.stats().streams === 1);
    world1.push(welcome);
    await tick(10);
    world1.push(ceremony);
    await waitFor(() => world1.logs.some((line) => line.includes("result could not be delivered")), "delivery log");
    assert.equal(world1.logs.some((line) => line.includes("HTTP 500")), true);
    world1.provider.stop();
  } finally {
    world1.restore();
  }
});
test("an error without a code omits the code field", async () => {
  const world1 = world({ consent: "approved", signer: () => ({ ok: false, error: { name: "NotAllowedError", message: "no code here" } }) });
  try {
    world1.provider.start();
    await waitFor(() => world1.stats().streams === 1);
    world1.push(ceremony);
    await waitFor(() => world1.posts.length >= 2, "error frames");
    const frames = world1.posts.flatMap((post) => post.body.frames as any[]);
    const errorFrame = frames.find((frame) => frame.kind === "error");
    assert.equal("code" in errorFrame, false);
    world1.provider.stop();
  } finally {
    world1.restore();
  }
});

test("the delivery policy is used when one is given", async () => {
  const world1 = world({ consent: "approved", deliveryPolicy: true });
  try {
    world1.provider.start();
    await waitFor(() => world1.stats().streams === 1);
    world1.push(ceremony);
    await waitFor(() => world1.posts.length >= 2, "delivered frames");
    assert.equal(world1.stats2().deliveryCalls >= 1, true);
    world1.provider.stop();
  } finally {
    world1.restore();
  }
});

test("a cancel aborts the signing attempt and nothing is delivered", async () => {
  let release: ((value: unknown) => void) | null = null;
  const world1 = world({ consent: "none", signer: () => new Promise((resolve) => { release = resolve; }) });
  try {
    world1.provider.start();
    await waitFor(() => world1.stats().streams === 1);
    world1.push(ceremony);
    await waitFor(() => world1.signal() !== null, "signing");
    const before = world1.posts.length;
    world1.push({ kind: "cancel", requestId: "req-1" });
    await waitFor(() => world1.signal()?.aborted === true, "aborted");
    if (release !== null) (release as (value: unknown) => void)({ ok: true, credentialJson: "{}" });
    await tick(20);
    assert.equal(world1.posts.length, before);
    world1.provider.stop();
  } finally {
    world1.restore();
  }
});

test("a new stream starts without the previous provider id", async () => {
  const world1 = world({ reconnectTwice: true });
  try {
    world1.provider.start();
    await waitFor(() => world1.stats().streams === 1, "first stream");
    world1.push(welcome);
    await waitFor(() => world1.posts.length === 1, "hello");
    world1.close();
    await waitFor(() => world1.stats().streams === 2, "second stream");
    world1.push(ceremony);
    await waitFor(() => world1.posts.length >= 2, "ceremony on new stream");
    const last = world1.posts.at(-1)?.body as any;
    assert.equal("providerId" in last, false);
    world1.provider.stop();
  } finally {
    world1.restore();
  }
});

test("stopping aborts the open request stream", async () => {
  const world1 = world({});
  try {
    world1.provider.start();
    await waitFor(() => world1.stats().streams === 1);
    world1.provider.stop();
    await waitFor(() => world1.stats2().abortSignalFired >= 1, "stream abort");
  } finally {
    world1.restore();
  }
});
