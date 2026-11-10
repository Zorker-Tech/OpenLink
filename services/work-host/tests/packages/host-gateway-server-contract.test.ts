/**
 * What the host gateway trusts, routes, streams and closes at its HTTP boundary.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { gunzipSync } from "node:zlib";
import { describe, it } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  GATEWAY_REQUEST_ID_HEADER,
  GZIP_MIN_BYTES,
  MAX_BODY_BYTES,
  MAX_REQUEST_PAYLOAD_BYTES,
  SSE_HEARTBEAT_MS,
  clientAcceptsGzip,
  clientWantsSlimAvatars,
  hostHeaderHostname,
  isAuthorized,
  openSseStream,
  parseSubscribedChannels,
  readBody,
  rejectUntrustedBrowserRequest,
  respondError,
  respondJson,
  startGatewayServer,
  type GatewayServerDeps,
} from "../../source/gateway/gateway-server.ts";
import {
  SLATE_GATEWAY,
} from "../../source/shared/gateway-wire.ts";
import { GATEWAY_LOCAL_EXEC_RESPONSES_PATH } from "../../source/shared/local-exec-gateway.ts";
import { GATEWAY_WEBAUTHN_RESPONSES_PATH } from "../../source/shared/webauthn-gateway.ts";

class FakeResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string | number> = {};
  headersSent = false;
  destroyed = false;
  writableEnded = false;
  chunks: Buffer[] = [];

  writeHead(status: number, headers: Record<string, string | number>): this {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Buffer): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.write(chunk);
    this.writableEnded = true;
    this.emit("close");
    return this;
  }

  body(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function request(headers: Record<string, string | string[] | undefined> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function dependencies(overrides: Partial<GatewayServerDeps> = {}): GatewayServerDeps {
  const api = {
    getAgentAvatar: async () => ({ dataUrl: "data:image/png;base64,cG5n", version: "v1" }),
    getHostStatus: async () => ({ state: "ready" }),
    setHostSettings: async (value: unknown) => value,
    ...overrides.api,
  };
  return {
    api: api as never,
    subscribe: () => () => {},
    getHealth: () => ({ isBusy: false, activeAgentId: "agent-1", lastBusyAtMs: 123 }),
    startedAt: 100,
    ...overrides,
  } as GatewayServerDeps;
}

async function withGateway<T>(deps: GatewayServerDeps, visit: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await startGatewayServer({ ...deps, host: "127.0.0.1" });
  try {
    return await visit(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.close();
  }
}

describe("request and response helpers", () => {
  it("reads a request body from multiple byte chunks and exposes its configured size ceiling", async () => {
    async function* parts() {
      yield Buffer.from("hello ");
      yield new TextEncoder().encode("world");
    }
    assert.equal(await readBody(parts()), "hello world");
    assert.equal(MAX_REQUEST_PAYLOAD_BYTES, 256 * 1024 * 1024);
    assert.equal(MAX_BODY_BYTES, Math.ceil(MAX_REQUEST_PAYLOAD_BYTES * 4 / 3) + 64 * 1024);
  });

  it("checks bearer credentials by exact scheme and length", () => {
    assert.equal(isAuthorized(request({ authorization: `${SLATE_GATEWAY.authentication.scheme} secret` }), "secret"), true);
    assert.equal(isAuthorized(request({ authorization: "bearer secret" }), "secret"), false);
    assert.equal(isAuthorized(request({ authorization: `${SLATE_GATEWAY.authentication.scheme} secret-extra` }), "secret"), false);
    assert.equal(isAuthorized(request({ authorization: ["Bearer secret"] }), "secret"), false);
  });

  it("parses loopback host names and blocks browser origins from the host gateway", () => {
    assert.deepEqual(
      ["127.0.0.1:4000", "[::1]:9", "example.test", "bad host"].map((host) => hostHeaderHostname(request({ host }))),
      ["127.0.0.1", "[::1]", "example.test", null],
    );

    const response = new FakeResponse();
    assert.equal(rejectUntrustedBrowserRequest({}, request({ origin: "https://evil.test" }), response as unknown as ServerResponse), true);
    assert.deepEqual([response.statusCode, JSON.parse(response.body().toString("utf8"))], [403, { error: "browser-origin gateway requests are not allowed" }]);
    const loopback = new FakeResponse();
    assert.equal(rejectUntrustedBrowserRequest({}, request({ host: "127.0.0.1:12" }), loopback as unknown as ServerResponse), false);
    const publicHost = new FakeResponse();
    assert.equal(rejectUntrustedBrowserRequest({}, request({ host: "remote.test" }), publicHost as unknown as ServerResponse), true);
  });

  it("reads gzip and slim-avatar preferences and filters subscribed channels", () => {
    assert.equal(clientAcceptsGzip(request({ "accept-encoding": "br, GZIP;q=0.5" })), true);
    assert.equal(clientAcceptsGzip(request({ "accept-encoding": ["identity"] })), false);
    assert.equal(clientWantsSlimAvatars(request({ "x-slate-slim-avatars": "1" })), true);
    assert.equal(clientWantsSlimAvatars(request({ "x-slate-slim-avatars": ["1", "0"] })), true);
    assert.equal(clientWantsSlimAvatars(request({ "x-slate-slim-avatars": "true" })), false);
    assert.deepEqual(parseSubscribedChannels(new URL("http://localhost/events?channels=agents, transcript,,agents")), new Set(["agents", "transcript"]));
    assert.equal(parseSubscribedChannels(new URL("http://localhost/events")), undefined);
    assert.equal(parseSubscribedChannels(new URL("http://localhost/events?channels=,,")), undefined);
    assert.equal(SSE_HEARTBEAT_MS, 15_000);
  });

  it("compresses large JSON only when requested, and writes errors in the standard envelope", async () => {
    const response = new FakeResponse();
    const requested = request({ "accept-encoding": "gzip" });
    await new Promise<void>((resolve) => {
      response.once("close", resolve);
      respondJson(response as unknown as ServerResponse, { payload: "x".repeat(GZIP_MIN_BYTES) }, requested);
    });
    assert.equal(response.headers["content-encoding"], "gzip");
    assert.equal(JSON.parse(gunzipSync(response.body()).toString("utf8")).payload.length, GZIP_MIN_BYTES);

    const error = new FakeResponse();
    respondError(error as unknown as ServerResponse, 401, "unauthorized");
    assert.deepEqual([error.statusCode, JSON.parse(error.body().toString("utf8"))], [401, { error: "unauthorized" }]);
  });

  it("sends an SSE retry line, streams registered events and disposes its subscription on close", () => {
    const response = new FakeResponse();
    let writeEvent: ((value: string) => void) | undefined;
    let unsubscribed = 0;
    openSseStream(request({ "accept-encoding": "identity" }), response as unknown as ServerResponse, (write) => {
      writeEvent = write;
      return () => { unsubscribed += 1; };
    });
    assert.equal(response.headers["content-type"], "text/event-stream");
    assert.match(response.body().toString("utf8"), /retry: 1000/);
    writeEvent?.('{"channel":"agents"}');
    assert.match(response.body().toString("utf8"), /data: \{"channel":"agents"\}/);
    response.emit("close");
    assert.equal(unsubscribed, 1);
  });
});

describe("the HTTP gateway routes", () => {
  it("serves health and known commands, and returns 404 for unknown paths and methods", async () => {
    await withGateway(dependencies(), async (base) => {
      const health = await fetch(`${base}${SLATE_GATEWAY.paths.health}`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), {
        ok: true,
        pid: process.pid,
        isBusy: false,
        activeAgentId: "agent-1",
        startedAt: 100,
        lastBusyAtMs: 123,
      });

      const command = await fetch(`${base}/api/getHostStatus`, { method: "POST", body: "" });
      assert.equal(command.status, 200);
      assert.deepEqual(await command.json(), { state: "ready" });
      const missing = await fetch(`${base}/unknown`);
      assert.deepEqual([missing.status, await missing.json()], [404, { error: "not found: GET /unknown" }]);
      const unknownCommand = await fetch(`${base}/api/notACommand`, { method: "POST", body: "{}" });
      assert.deepEqual([unknownCommand.status, await unknownCommand.json()], [404, { error: "unknown gateway method: notACommand" }]);
    });
  });

  it("requires the configured bearer token, and rejects any browser origin even when authenticated", async () => {
    await withGateway(dependencies({ authToken: "local-secret" }), async (base) => {
      const missing = await fetch(`${base}/api/getHostStatus`, { method: "POST" });
      assert.equal(missing.status, 401);
      const authorized = await fetch(`${base}${SLATE_GATEWAY.paths.api}/getHostStatus`, { method: "POST", headers: { authorization: `${SLATE_GATEWAY.authentication.scheme} local-secret` } });
      assert.equal(authorized.status, 200);
      const wrong = await fetch(`${base}${SLATE_GATEWAY.paths.api}/getHostStatus`, { method: "POST", headers: { authorization: `${SLATE_GATEWAY.authentication.scheme} wrong` } });
      assert.equal(wrong.status, 401);
      const browser = await fetch(`${base}${SLATE_GATEWAY.paths.api}/getHostStatus`, { method: "POST", headers: { authorization: `${SLATE_GATEWAY.authentication.scheme} local-secret`, origin: "https://evil.test" } });
      assert.deepEqual([browser.status, await browser.json()], [403, { error: "browser-origin gateway requests are not allowed" }]);
    });
  });

  it("requires gateway authentication for machine bridge endpoints", async () => {
    await withGateway(dependencies(), async (base) => {
      const localBridge = await fetch(`${base}${GATEWAY_LOCAL_EXEC_RESPONSES_PATH}`, { method: "POST", body: "{}" });
      assert.deepEqual([localBridge.status, await localBridge.json()], [401, { error: "local-exec requires gateway authentication" }]);
      const webauthnBridge = await fetch(`${base}${GATEWAY_WEBAUTHN_RESPONSES_PATH}`, { method: "POST", body: "{}" });
      assert.deepEqual([webauthnBridge.status, await webauthnBridge.json()], [401, { error: "webauthn requires gateway authentication" }]);
    });
  });

  it("routes JSON command arguments and reports command completion with request and trace ids", async () => {
    const completed: Array<Record<string, unknown>> = [];
    const apiCalls: unknown[] = [];
    const deps = dependencies({
      api: {
        setHostSettings: async (input: unknown) => (apiCalls.push(input), { saved: true }),
      } as never,
      onCommandComplete: (report) => completed.push(report),
    });
    await withGateway(deps, async (base) => {
      const response = await fetch(`${base}/api/setHostSettings`, {
        method: "POST",
        headers: {
          [GATEWAY_REQUEST_ID_HEADER]: "request-1",
          "traceparent": "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ theme: "dark" }),
      });
      assert.deepEqual(await response.json(), { saved: true });
    });
    assert.deepEqual(apiCalls, [{ theme: "dark" }]);
    assert.deepEqual(
      [completed[0]?.method, completed[0]?.requestId, completed[0]?.traceId, completed[0]?.spanId],
      ["setHostSettings", "request-1", "0123456789abcdef0123456789abcdef", "0123456789abcdef"],
    );
  });

  it("reports backend failures to telemetry and returns the error status", async () => {
    const reports: Array<Record<string, unknown>> = [];
    const deps = dependencies({
      api: { getHostStatus: async () => { throw new Error("unavailable"); } } as never,
      onCommandError: (report) => reports.push(report),
    });
    await withGateway(deps, async (base) => {
      const response = await fetch(`${base}/api/getHostStatus`, { method: "POST" });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "unavailable" });
    });
    assert.equal(reports[0]?.method, "getHostStatus");
    assert.equal(typeof reports[0]?.durationMs, "number");
  });

  it("serves avatar versions with safe headers and rejects cross-site or stale versions", async () => {
    let avatarReads = 0;
    const deps = dependencies({
      api: { getAgentAvatar: async () => (avatarReads += 1, { dataUrl: "data:image/png;base64,cG5n", version: "v1" }) } as never,
    });
    await withGateway(deps, async (base) => {
      const blocked = await fetch(`${base}/avatars/agent-1?v=v1`, { headers: { "sec-fetch-site": "cross-site" } });
      assert.deepEqual([blocked.status, await blocked.json()], [403, { error: "cross-site avatar loads are not allowed" }]);
      const stale = await fetch(`${base}/avatars/agent-1?v=old`);
      assert.deepEqual([stale.status, await stale.json()], [404, { error: "no such avatar version" }]);
      const image = await fetch(`${base}/avatars/agent-1?v=v1`);
      assert.deepEqual([image.status, image.headers.get("content-type"), image.headers.get("x-content-type-options"), Buffer.from(await image.arrayBuffer()).toString("utf8")], [200, "image/png", "nosniff", "png"]);
      assert.match(image.headers.get("content-disposition") ?? "", /attachment/);
      const notChanged = await fetch(`${base}/avatars/agent-1?v=v1`, { headers: { "if-none-match": '"v1"' } });
      assert.equal(notChanged.status, 304);
      assert.equal(avatarReads, 3);
    });
  });

  it("hands machine responses to the local bridge and notes desktop contact", async () => {
    const received: unknown[] = [];
    let contactCount = 0;
    const deps = dependencies({
      authToken: "local-secret",
      localExec: {
        registerProvider: () => () => {},
        submitResponses: (batch) => { received.push(batch); },
      },
      onDesktopContact: () => { contactCount += 1; },
    });
    await withGateway(deps, async (base) => {
      const response = await fetch(`${base}${GATEWAY_LOCAL_EXEC_RESPONSES_PATH}`, {
        method: "POST",
        headers: { authorization: `${SLATE_GATEWAY.authentication.scheme} local-secret`, "content-type": "application/json" },
        body: JSON.stringify({ answers: [1] }),
      });
      assert.deepEqual(await response.json(), { ok: true });
    });
    assert.deepEqual(received, [{ answers: [1] }]);
    assert.equal(contactCount, 1);
  });

  it("filters the event stream by channel, slims inline avatars and unsubscribes on disconnect", async () => {
    let listener: ((event: unknown) => void) | undefined;
    let unsubscribed = 0;
    let streamClosed = 0;
    const deps = dependencies({
      subscribe: (next) => {
        listener = next;
        return () => { unsubscribed += 1; };
      },
      onEventStreamClosed: () => { streamClosed += 1; },
    });
    const abort = new AbortController();

    await withGateway(deps, async (base) => {
      const response = await fetch(`${base}${SLATE_GATEWAY.paths.events}?channels=agents`, {
        headers: { "x-slate-slim-avatars": "1", "accept-encoding": "identity" },
        signal: abort.signal,
      });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.match(new TextDecoder().decode(first.value), /retry: 1000/);

      listener?.({ channel: "other", payload: { value: 1 } });
      listener?.({ channel: "agents", payload: { agents: [{ id: "a-1", avatarDataUrl: "data:image/png;base64,cG5n" }] } });
      const event = await reader.read();
      const frame = new TextDecoder().decode(event.value);
      assert.match(frame, /"channel":"agents"/);
      assert.match(frame, /"avatarDataUrl":null/);
      assert.equal(frame.includes('"value":1'), false);

      abort.abort();
      try {
        await reader.read();
      } catch {
        // The connection ends when its caller disconnects.
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual([unsubscribed, streamClosed], [1, 1]);
  });
});
