import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { describe, it } from "node:test";

import {
  McpOAuthLoopbackRegistry,
  loopbackBindHosts,
  parseLoopbackRedirect,
  type CoordinatorLogger,
  type McpOAuthLoopbackHandler,
} from "../../source/coordinator/oauth/mcp-oauth-loopback-registry.ts";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert.notEqual(address, null);
  if (address === null || typeof address === "string") throw new Error("ephemeral listener did not expose a port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function httpRequest(port: number, path = "/callback"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = get({ hostname: "127.0.0.1", port, path }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
  });
}

function logger() {
  const warnings: Array<Record<string, unknown>> = [];
  const value: CoordinatorLogger = { warn: (event) => warnings.push(event) };
  return { value, warnings };
}

describe("MCP OAuth loopback registry behavior contract", () => {
  it("accepts only localhost HTTP redirects with an explicit positive port", () => {
    assert.deepEqual(parseLoopbackRedirect(new URL("http://127.0.0.1:4567/callback?state=s")), { port: 4567 });
    assert.deepEqual(parseLoopbackRedirect(new URL("http://localhost:3210/callback")), { port: 3210 });
    for (const raw of [
      "https://127.0.0.1:4567/callback",
      "http://example.test:4567/callback",
      "http://[::1]:4567/callback",
      "http://127.0.0.1/callback",
      "http://127.0.0.1:0/callback",
    ]) assert.throws(() => parseLoopbackRedirect(new URL(raw)), /MCP OAuth redirect_uri/);
  });

  it("binds localhost to both loopback families and a numeric address only to itself", () => {
    assert.deepEqual(loopbackBindHosts("localhost"), ["127.0.0.1", "::1"]);
    assert.deepEqual(loopbackBindHosts("127.0.0.1"), ["127.0.0.1"]);
    assert.deepEqual(loopbackBindHosts("::1"), ["::1"]);
  });

  it("dispatches handlers in registration order until one claims the callback", async () => {
    const port = await availablePort();
    const log = logger();
    const registry = new McpOAuthLoopbackRegistry(log.value);
    const order: string[] = [];
    const first: McpOAuthLoopbackHandler = (url) => { order.push(`first:${url.pathname}:${url.searchParams.get("code")}`); return false; };
    const second: McpOAuthLoopbackHandler = (_url, _request, response) => {
      order.push("second");
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("accepted");
      return true;
    };
    let releaseFirst: (() => Promise<void>) | undefined;
    let releaseSecond: (() => Promise<void>) | undefined;
    try {
      const redirect = new URL(`http://127.0.0.1:${port}/callback`);
      [releaseFirst, releaseSecond] = await Promise.all([registry.acquire(redirect, first), registry.acquire(redirect, second)]);
      assert.deepEqual(await httpRequest(port, "/callback?code=ok"), { status: 200, body: "accepted" });
      assert.deepEqual(order, ["first:/callback:ok", "second"]);
      assert.deepEqual(log.warnings, []);
    } finally {
      await releaseFirst?.();
      await releaseSecond?.();
      await registry.dispose();
    }
  });

  it("keeps the shared server alive until the last distinct handler releases", async () => {
    const port = await availablePort();
    const registry = new McpOAuthLoopbackRegistry(logger().value);
    const handlerA: McpOAuthLoopbackHandler = (_url, _request, response) => { response.end("A"); return true; };
    const handlerB: McpOAuthLoopbackHandler = (_url, _request, response) => { response.end("B"); return true; };
    let releaseA: (() => Promise<void>) | undefined;
    let releaseB: (() => Promise<void>) | undefined;
    try {
      const redirect = new URL(`http://127.0.0.1:${port}/callback`);
      [releaseA, releaseB] = await Promise.all([registry.acquire(redirect, handlerA), registry.acquire(redirect, handlerB)]);
      await releaseA();
      assert.deepEqual(await httpRequest(port), { status: 200, body: "B" });
      await releaseA();
      await releaseB();
      await assert.rejects(() => httpRequest(port));
    } finally {
      await releaseA?.();
      await releaseB?.();
      await registry.dispose();
    }
  });

  it("returns 404 when no handler claims a callback and logs handler failures before continuing", async () => {
    const port = await availablePort();
    const log = logger();
    const registry = new McpOAuthLoopbackRegistry(log.value);
    const failed: McpOAuthLoopbackHandler = () => { throw new Error("handler exploded"); };
    const declines: McpOAuthLoopbackHandler = () => false;
    let releaseFailed: (() => Promise<void>) | undefined;
    let releaseDeclines: (() => Promise<void>) | undefined;
    try {
      const redirect = new URL(`http://127.0.0.1:${port}/callback`);
      [releaseFailed, releaseDeclines] = await Promise.all([
        registry.acquire(redirect, failed),
        registry.acquire(redirect, declines),
      ]);
      assert.deepEqual(await httpRequest(port), { status: 404, body: "Not found" });
      assert.deepEqual(log.warnings, [{ kind: "callback-handler-failed", detail: "handler exploded" }]);
    } finally {
      await releaseFailed?.();
      await releaseDeclines?.();
      await registry.dispose();
    }
  });

  it("makes a release idempotent and closes the listener when its last handler leaves", async () => {
    const port = await availablePort();
    const registry = new McpOAuthLoopbackRegistry(logger().value);
    const handler: McpOAuthLoopbackHandler = (_url, _request, response) => { response.end("done"); return true; };
    let release: (() => Promise<void>) | undefined;
    try {
      release = await registry.acquire(new URL(`http://127.0.0.1:${port}/callback`), handler);
      assert.deepEqual(await httpRequest(port), { status: 200, body: "done" });
      await release();
      await release();
      await assert.rejects(() => httpRequest(port));
    } finally {
      await release?.();
      await registry.dispose();
    }
  });

  it("closes active listeners during dispose and tolerates later lease releases", async () => {
    const port = await availablePort();
    const registry = new McpOAuthLoopbackRegistry(logger().value);
    const handler: McpOAuthLoopbackHandler = () => false;
    const release = await registry.acquire(new URL(`http://127.0.0.1:${port}/callback`), handler);
    await registry.dispose();
    await release();
    await registry.dispose();
    await assert.rejects(() => httpRequest(port));
  });

  it("rejects a bind when the requested loopback port is already occupied", async () => {
    const port = await availablePort();
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(port, "127.0.0.1", () => { occupied.off("error", reject); resolve(); });
    });
    const registry = new McpOAuthLoopbackRegistry(logger().value);
    try {
      await assert.rejects(
        () => registry.acquire(new URL(`http://127.0.0.1:${port}/callback`), () => false),
        /address already in use|EADDRINUSE/i,
      );
    } finally {
      await registry.dispose();
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
});
