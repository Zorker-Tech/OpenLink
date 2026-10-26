import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  DEFAULT_SLATE_COMPUTER_ID,
  isSameLocalExecConnection,
  RESPONSE_POST_RETRIES,
  RESPONSE_POST_RETRY_DELAY_MS,
  SlateLocalExecProvider,
  SlateLocalExecStreamError,
  SSE_RECONNECT_MAX_MS,
  SSE_RECONNECT_MIN_MS,
  SSE_STALL_TIMEOUT_MS,
  STALE_CONNECTION_FAILURE_THRESHOLD,
  withLocalExecAuth,
  type LocalExecExecutor,
  type LocalExecExecutorOutput,
  type LocalExecRequestFrame,
  type LocalExecResponseFrame,
  type SlateLocalExecProviderOptions,
} from "../../source/host/local-exec/local-exec-provider.ts";
import type { LocalExecConnection } from "../../source/host/local-exec/local-exec-daemon-protocol.ts";
import { GATEWAY_AUTH_SCHEME } from "../../source/shared/gateway-wire.ts";
import { DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES, GATEWAY_LOCAL_EXEC_REQUESTS_PATH, GATEWAY_LOCAL_EXEC_RESPONSES_PATH, localExecFileTooLargeMessage } from "../../source/shared/local-exec-gateway.ts";

interface CapturedFetch {
  readonly url: string;
  readonly init?: RequestInit;
}

const temporaryRoots: string[] = [];
after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "slate-local-exec-provider-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "files"), { recursive: true });
  return root;
}

function executor(overrides: Partial<LocalExecExecutor> = {}): LocalExecExecutor {
  const standard: LocalExecExecutor = {
    decodeServerMessage: () => ({ id: 0 }),
    async *execute() {},
    cancel() {},
    throwControl: (error) => ({ error }),
  };
  return { ...standard, ...overrides };
}

function providerHarness(overrides: Partial<SlateLocalExecProviderOptions> = {}) {
  const root = overrides.root ?? workspace();
  const calls: CapturedFetch[] = [];
  const connection: LocalExecConnection = {
    baseUrl: "https://gateway.example.test",
    token: "local-token",
    headers: { "x-gateway": "provided" },
  };
  const defaultFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
    return new Response(null, { status: 200 });
  };
  const { fetch: requestedFetch, ...otherOptions } = overrides;
  const provider = new SlateLocalExecProvider({
    resolveConnection: async () => connection,
    executor: executor(),
    root,
    computerId: "machine-1",
    computerLabel: "Test machine",
    maxFileBytes: 4,
    ...otherOptions,
    fetch: requestedFetch ?? defaultFetch,
  });
  return { provider, root, calls, connection };
}

function postedBodies(calls: readonly CapturedFetch[]): Array<{ providerId?: string; frames: LocalExecResponseFrame[] }> {
  return calls
    .filter((call) => call.init?.method === "POST")
    .map((call) => JSON.parse(String(call.init?.body)) as { providerId?: string; frames: LocalExecResponseFrame[] });
}

function postedFrames(calls: readonly CapturedFetch[]): LocalExecResponseFrame[] {
  return postedBodies(calls).flatMap((body) => body.frames);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(predicate(), true, "expected asynchronous provider work to settle");
}

async function waitForRetryWork(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(predicate(), true, "expected retry work to settle");
}

async function connect(provider: SlateLocalExecProvider): Promise<void> {
  await provider.handleRequest({ kind: "welcome", providerId: "provider-7" });
}

describe("the machine-local execution provider", () => {
  it("merges gateway headers and adds authorization only for a nonempty token", () => {
    const supplied = { authorization: "old", "x-client": "caller" };
    const connection = {
      baseUrl: "https://gateway.example.test",
      token: "secret",
      headers: { authorization: "connection", "x-gateway": "yes" },
    };

    assert.deepEqual(withLocalExecAuth(supplied, connection), {
      authorization: `${GATEWAY_AUTH_SCHEME} secret`,
      "x-client": "caller",
      "x-gateway": "yes",
    });
    assert.deepEqual(supplied, { authorization: "old", "x-client": "caller" });
    assert.deepEqual(withLocalExecAuth({}, { ...connection, token: "" }), {
      authorization: "connection",
      "x-gateway": "yes",
    });
  });

  it("compares the exact dialed connection and exposes the intended machine identity", () => {
    assert.equal(DEFAULT_SLATE_COMPUTER_ID, "this-computer");
    assert.equal(SSE_RECONNECT_MIN_MS, 1_000);
    assert.equal(SSE_RECONNECT_MAX_MS, 10_000);
    assert.equal(SSE_STALL_TIMEOUT_MS, 35_000);
    assert.equal(STALE_CONNECTION_FAILURE_THRESHOLD, 3);
    assert.equal(RESPONSE_POST_RETRIES, 3);
    assert.equal(RESPONSE_POST_RETRY_DELAY_MS, 200);
    assert.equal(isSameLocalExecConnection(
      { baseUrl: "https://gateway.test", token: "a", headers: { one: "1", two: "2" } },
      { baseUrl: "https://gateway.test", token: "a", headers: { one: "1", two: "2" } },
    ), true);
    assert.equal(isSameLocalExecConnection(
      { baseUrl: "https://gateway.test", token: "a", headers: { one: "1", two: "2" } },
      { baseUrl: "https://gateway.test", token: "a", headers: { two: "2", one: "1" } },
    ), false);
    assert.equal(isSameLocalExecConnection(
      { baseUrl: "https://gateway.test", token: "a" },
      { baseUrl: "https://other.test", token: "a" },
    ), false);
    assert.equal(isSameLocalExecConnection(
      { baseUrl: "https://gateway.test", token: "a" },
      { baseUrl: "https://gateway.test", token: "a", headers: {} },
    ), true);

    const identity = new SlateLocalExecProvider({
      resolveConnection: async () => ({ baseUrl: "https://gateway.test" }),
      executor: executor(),
      root: workspace(),
      computerId: "  machine-label  ",
      computerLabel: "  My computer  ",
    });
    assert.equal(identity.computerId, "machine-label");
    assert.equal(identity.computerLabel, "My computer");
  });

  it("uses the machine host name and standard byte limit when options omit them", () => {
    const provider = new SlateLocalExecProvider({
      resolveConnection: async () => ({ baseUrl: "https://gateway.test" }),
      executor: executor(),
      root: workspace(),
    });
    const hostName = hostname().trim();

    assert.equal(provider.computerId, hostName || DEFAULT_SLATE_COMPUTER_ID);
    assert.equal(provider.computerLabel, hostName || "this computer");
    assert.equal(provider.maxFileBytes, DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES);
  });

  it("executes decoded work, assigns its local id and posts the resulting frames", async () => {
    const inflight: number[] = [];
    const seenIds: number[] = [];
    const { provider, calls } = providerHarness({
      onInflightChange: (count) => inflight.push(count),
      executor: executor({
        decodeServerMessage: () => ({ id: 0, message: { case: "read", value: {} } }),
        async *execute(message) {
          seenIds.push(message.id);
          yield { kind: "client", message: { completed: message.id } };
        },
      }),
    });

    await connect(provider);
    await provider.handleRequest({ kind: "exec", requestId: "exec-1", serverMessage: { op: "read" } });
    await waitFor(() => postedFrames(calls).length === 1);

    assert.deepEqual(seenIds, [1]);
    assert.deepEqual(inflight, [1, 0]);
    assert.deepEqual(postedBodies(calls)[0], {
      providerId: "provider-7",
      frames: [{ kind: "client", requestId: "exec-1", message: { completed: 1 } }],
    });
    const post = calls.find((call) => call.init?.method === "POST");
    assert.equal(post?.url, `https://gateway.example.test${GATEWAY_LOCAL_EXEC_RESPONSES_PATH}`);
    assert.equal(new Headers(post?.init?.headers).get("content-type"), "application/json");
  });

  it("keeps responses queued while an earlier batch is still posting", async () => {
    const posts: Array<{ url: string; init?: RequestInit }> = [];
    let resolveFirstPost!: (response: Response) => void;
    const fetcher: typeof fetch = async (input, init) => {
      if (init?.method !== "POST") return new Response(null, { status: 200 });
      posts.push({ url: String(input), ...(init === undefined ? {} : { init }) });
      if (posts.length === 1) return new Promise<Response>((resolve) => { resolveFirstPost = resolve; });
      return new Response(null, { status: 200 });
    };
    const { provider } = providerHarness({
      fetch: fetcher,
      executor: executor({
        async *execute(message) {
          yield { kind: "client", message: { id: message.id } };
        },
      }),
    });

    await connect(provider);
    await provider.handleRequest({ kind: "exec", requestId: "first", serverMessage: {} });
    await waitFor(() => posts.length === 1);
    await provider.handleRequest({ kind: "exec", requestId: "second", serverMessage: {} });
    assert.equal(posts.length, 1);
    resolveFirstPost(new Response(null, { status: 200 }));
    await waitFor(() => posts.length === 2);

    const allFrames = posts.flatMap((post) => JSON.parse(String(post.init?.body)).frames as LocalExecResponseFrame[]);
    assert.deepEqual(allFrames.map((frame) => frame.kind === "client" ? [frame.requestId, frame.message] : []), [
      ["first", { id: 1 }],
      ["second", { id: 2 }],
    ]);
  });

  it("turns decode failures into executor control responses", async () => {
    const { provider, calls } = providerHarness({
      executor: executor({
        decodeServerMessage: () => { throw new Error("cannot decode"); },
        throwControl: (error) => ({ refused: error }),
      }),
    });

    await connect(provider);
    await provider.handleRequest({ kind: "exec", requestId: "bad-exec", serverMessage: { malformed: true } });
    await waitFor(() => postedFrames(calls).length === 1);

    assert.deepEqual(postedFrames(calls), [{
      kind: "control",
      requestId: "bad-exec",
      message: { refused: "cannot decode" },
    }]);
  });

  it("cancels the matching execution, aborts its signal and reports the in-flight count", async () => {
    const active: AbortSignal[] = [];
    const events: string[] = [];
    const inflight: number[] = [];
    const { provider, calls } = providerHarness({
      onInflightChange: (count) => inflight.push(count),
      executor: executor({
        async *execute(_message, signal) {
          active.push(signal);
          await new Promise<void>((resolve) => {
            const safetyTimer = setTimeout(resolve, 100);
            signal.addEventListener("abort", () => {
              clearTimeout(safetyTimer);
              events.push("aborted");
              resolve();
            }, { once: true });
          });
          yield { kind: "control", message: { cancelled: signal.aborted } };
        },
        cancel: (id) => events.push(`cancel:${id}`),
      }),
    });

    await connect(provider);
    const execution = provider.handleRequest({ kind: "exec", requestId: "exec-cancel", serverMessage: {} });
    await waitFor(() => active.length === 1);
    await provider.handleRequest({ kind: "cancel", requestId: "exec-cancel" });
    await execution;
    await waitFor(() => postedFrames(calls).length === 1);

    assert.deepEqual(events, ["cancel:1", "aborted"]);
    assert.equal(active[0]?.aborted, true);
    assert.deepEqual(inflight, [1, 0]);
    assert.deepEqual(postedFrames(calls), [{
      kind: "control",
      requestId: "exec-cancel",
      message: { cancelled: true },
    }]);
  });

  it("aborts active executor work when the provider closes", async () => {
    const signals: AbortSignal[] = [];
    const inflight: number[] = [];
    const { provider } = providerHarness({
      onInflightChange: (count) => inflight.push(count),
      executor: executor({
        async *execute(_message, signal) {
          signals.push(signal);
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        },
      }),
    });

    const execution = provider.handleRequest({ kind: "exec", requestId: "exec-close", serverMessage: {} });
    await waitFor(() => signals.length === 1);
    provider.close();
    await execution;

    assert.equal(signals[0]?.aborted, true);
    assert.deepEqual(inflight, [1, 0]);
  });

  it("does not reconnect after close aborts the active request stream", async () => {
    let releaseResponse!: (response: Response) => void;
    let requestSignal: AbortSignal | undefined;
    let requestCount = 0;
    const root = workspace();
    const fetcher: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") return new Response(null, { status: 200 });
      requestCount += 1;
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { releaseResponse = resolve; });
    };
    const { provider } = providerHarness({ root, fetch: fetcher });

    provider.start();
    await waitFor(() => requestSignal !== undefined);
    provider.close();
    assert.equal(requestSignal?.aborted, true);
    releaseResponse(new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }), { status: 200 }));
    await waitFor(() => requestCount === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(requestCount, 1);
  });

  it("does not send responses queued after close", async () => {
    const { provider, calls } = providerHarness();
    provider.close();
    await provider.handleRequest({ kind: "upload", requestId: "after-close", path: "files/after.txt", bytesBase64: "YQ==" });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.some((call) => call.init?.method === "POST"), false);
  });

  it("retires approvals and sends file actions through the local-use gate", async () => {
    const retired: string[] = [];
    const requests: Array<{ approvalId?: string; describes?: unknown; terminalsFolder: string }> = [];
    const { provider, calls, root } = providerHarness({
      onApprovalRetired: (approvalId) => { retired.push(approvalId); },
      isLocalUseBlocked: (request) => {
        requests.push(request);
        return "approval is required";
      },
    });

    await connect(provider);
    await provider.handleRequest({ kind: "retire-approval", approvalId: "approval-1" });
    await provider.handleRequest({ kind: "upload", requestId: "blocked-write", approvalId: "approval-2", path: "files/blocked.txt", bytesBase64: "YQ==" });
    await waitFor(() => postedFrames(calls).length === 1);
    await provider.handleRequest({ kind: "download", requestId: "blocked-read", path: "files/blocked.txt" });
    await waitFor(() => postedFrames(calls).length === 2);
    await provider.handleRequest({ kind: "exec", requestId: "blocked-exec", serverMessage: {} });
    await waitFor(() => postedFrames(calls).length === 3);

    assert.deepEqual(retired, ["approval-1"]);
    assert.deepEqual(requests, [
      { approvalId: "approval-2", describes: { action: "write-file", target: "files/blocked.txt" }, terminalsFolder: join(root, "terminals") },
      { describes: { action: "read-file", target: "files/blocked.txt", attachToResourcePath: "files/blocked.txt" }, terminalsFolder: join(root, "terminals") },
      { terminalsFolder: join(root, "terminals") },
    ]);
    assert.deepEqual(postedFrames(calls).map((frame) => frame.kind), ["file-error", "file-error", "control"]);
    assert.equal(existsSync(join(root, "files", "blocked.txt")), false);
  });

  it("writes a bounded upload and returns a bounded download as Base64", async () => {
    const { provider, calls, root } = providerHarness();
    await connect(provider);

    await provider.handleRequest({ kind: "upload", requestId: "upload-1", path: "files/data.txt", bytesBase64: "YWJj" });
    await waitFor(() => postedFrames(calls).length === 1);
    assert.equal(readFileSync(join(root, "files", "data.txt"), "utf8"), "abc");

    await provider.handleRequest({ kind: "download", requestId: "download-1", path: "files/data.txt" });
    await waitFor(() => postedFrames(calls).length === 2);
    assert.deepEqual(postedFrames(calls), [
      { kind: "file", requestId: "upload-1" },
      { kind: "file", requestId: "download-1", bytesBase64: "YWJj" },
    ]);
  });

  it("uses the baseline floor when estimating a short unpadded upload", async () => {
    const { provider, calls, root } = providerHarness({ maxFileBytes: 2 });
    await connect(provider);
    await provider.handleRequest({ kind: "upload", requestId: "unpadded", path: "files/unpadded.txt", bytesBase64: "YWI" });
    await waitFor(() => postedFrames(calls).length === 1);

    assert.equal(readFileSync(join(root, "files", "unpadded.txt"), "utf8"), "ab");
    assert.deepEqual(postedFrames(calls), [{ kind: "file", requestId: "unpadded" }]);
  });

  it("refuses an oversized upload and a path outside the provider root", async () => {
    const { provider, calls, root } = providerHarness();
    await connect(provider);

    await provider.handleRequest({ kind: "upload", requestId: "too-large", path: "files/large.txt", bytesBase64: "YWJjZGU=" });
    await waitFor(() => postedFrames(calls).length === 1);
    const outsideName = `${root.split("/").at(-1)}-outside.txt`;
    await provider.handleRequest({ kind: "upload", requestId: "outside", path: `../${outsideName}`, bytesBase64: "YQ==" });
    await waitFor(() => postedFrames(calls).length === 2);

    const results = postedFrames(calls);
    assert.equal(results[0]?.kind, "file-error");
    if (results[0]?.kind === "file-error") assert.equal(results[0].error, localExecFileTooLargeMessage(6, 4));
    assert.equal(results[1]?.kind, "file-error");
    assert.equal(existsSync(join(root, "..", outsideName)), false);
  });

  it("refuses downloads that exceed the configured file limit", async () => {
    const { provider, calls, root } = providerHarness();
    writeFileSync(join(root, "files", "large.txt"), "12345");
    writeFileSync(join(root, "files", "at-limit.txt"), "1234");
    await connect(provider);
    await provider.handleRequest({ kind: "download", requestId: "large-download", path: "files/large.txt" });
    await waitFor(() => postedFrames(calls).length === 1);
    await provider.handleRequest({ kind: "download", requestId: "exact-download", path: "files/at-limit.txt" });
    await waitFor(() => postedFrames(calls).length === 2);

    const [tooLarge, exact] = postedFrames(calls);
    assert.equal(tooLarge?.kind, "file-error");
    if (tooLarge?.kind === "file-error") assert.equal(tooLarge.error, localExecFileTooLargeMessage(5, 4));
    assert.deepEqual(exact, { kind: "file", requestId: "exact-download", bytesBase64: "MTIzNA==" });
  });

  it("retries a failed response post three times, then drops that batch", async () => {
    const errors: string[] = [];
    let requestCount = 0;
    const priorError = console.error;
    const fetcher: typeof fetch = async () => {
      requestCount += 1;
      return new Response(null, { status: 503 });
    };
    const { provider } = providerHarness({ fetch: fetcher });
    console.error = (...values: unknown[]) => { errors.push(values.map(String).join(" ")); };

    try {
      await connect(provider);
      await provider.handleRequest({ kind: "upload", requestId: "retry-upload", path: "files/retry.txt", bytesBase64: "YQ==" });
      await waitForRetryWork(() => errors.length > 0);
    } finally {
      console.error = priorError;
    }

    assert.equal(requestCount, 3);
    assert.match(errors[0] ?? "", /3 failed POSTs/);
  });

  it("reads split server events and sends a hello frame on connection", async () => {
    const root = workspace();
    const retired: string[] = [];
    const calls: CapturedFetch[] = [];
    const text = [
      `data: ${JSON.stringify({ kind: "welcome", providerId: "server-provider" })}\n\n`,
      `data: ${JSON.stringify({ kind: "retire-approval", approvalId: "approval-sse" })}\n\n`,
    ].join("");
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 13));
        controller.enqueue(bytes.slice(13, 41));
        controller.enqueue(bytes.slice(41));
        controller.close();
      },
    });
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      if (init?.method === "POST") return new Response(null, { status: 200 });
      return new Response(stream, { status: 200 });
    };
    const { provider } = providerHarness({
      root,
      fetch: fetcher,
      isSupervised: () => true,
      variant: "test-variant",
      onApprovalRetired: (id) => { retired.push(id); },
    });
    let resetCount = 0;

    await provider.streamRequests(() => { resetCount += 1; });
    await waitFor(() => retired.length === 1 && calls.some((call) => call.init?.method === "POST"));

    const streamCall = calls.find((call) => call.init?.method !== "POST");
    assert.equal(streamCall?.url, `https://gateway.example.test${GATEWAY_LOCAL_EXEC_REQUESTS_PATH}`);
    assert.equal(new Headers(streamCall?.init?.headers).get("accept"), "text/event-stream");
    assert.equal(new Headers(streamCall?.init?.headers).get("authorization"), `${GATEWAY_AUTH_SCHEME} local-token`);
    assert.equal(resetCount, 1);
    assert.deepEqual(retired, ["approval-sse"]);
    const hello = postedFrames(calls).find((frame) => frame.kind === "hello");
    assert.deepEqual(hello, {
      kind: "hello",
      localRoot: root,
      terminalsFolder: join(root, "terminals"),
      computerId: "machine-1",
      label: "Test machine",
      supervised: true,
      variant: "test-variant",
    });
  });

  it("rejects a request stream without an HTTP body", async () => {
    const fetcher: typeof fetch = async () => new Response(null, { status: 503 });
    const { provider } = providerHarness({ fetch: fetcher });

    await assert.rejects(provider.streamRequests(), (error) => {
      assert.equal(error instanceof SlateLocalExecStreamError, true);
      assert.match((error as Error).message, /requests stream failed: 503/);
      return true;
    });

    const bodyless = providerHarness({ fetch: async () => new Response(null, { status: 200 }) });
    await assert.rejects(bodyless.provider.streamRequests(), /requests stream failed: 200/);
  });

  it("rejects an event that exceeds the upload-frame bound without parsing its body", async () => {
    const root = workspace();
    const calls: CapturedFetch[] = [];
    let parsed: string | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
      if (init?.method === "POST") return new Response(null, { status: 200 });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const providerLimit = 64 * 1024 + 8;
          const oversized = `data: {"requestId":"oversized","body":"${"x".repeat(providerLimit)}"}\n\n`;
          controller.enqueue(new TextEncoder().encode(oversized));
          controller.close();
        },
      }), { status: 200 });
    };
    const { provider } = providerHarness({ root, maxFileBytes: 1, fetch: fetcher });
    const original = provider.handleRequest.bind(provider);
    provider.handleRequest = async (frame: LocalExecRequestFrame) => {
      parsed = frame.kind;
      return original(frame);
    };

    await provider.streamRequests();
    await waitFor(() => postedFrames(calls).some((frame) => frame.kind === "file-error"));

    const refused = postedFrames(calls).find((frame) => frame.kind === "file-error");
    assert.equal(parsed, undefined);
    assert.equal(refused?.kind, "file-error");
    if (refused?.kind === "file-error") assert.equal(refused.requestId, "oversized");
  });

  it("accepts a complete event whose length equals the upload-frame bound", async () => {
    const root = workspace();
    let parsedKind: string | undefined;
    let instance: SlateLocalExecProvider | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") return new Response(null, { status: 200 });
      const empty = `data: ${JSON.stringify({ kind: "welcome", providerId: "edge", padding: "" })}`;
      const padding = (instance?.maxUploadFrameBytes ?? 0) - empty.length;
      const event = `data: ${JSON.stringify({ kind: "welcome", providerId: "edge", padding: "x".repeat(padding) })}`;
      assert.equal(event.length, instance?.maxUploadFrameBytes);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${event}\n\n`));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    };
    const harness = providerHarness({ root, maxFileBytes: 1, fetch: fetcher });
    instance = harness.provider;
    assert.equal(instance.maxUploadFrameBytes, 65_538);
    const handle = instance.handleRequest.bind(instance);
    instance.handleRequest = async (frame: LocalExecRequestFrame) => {
      parsedKind = frame.kind;
      return handle(frame);
    };

    await instance.streamRequests();

    assert.equal(parsedKind, "welcome");
  });
});
