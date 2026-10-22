import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
import { createServer } from "node:net";
import { describe, it } from "node:test";

import {
  CONNECTOR_OAUTH_CALLBACK_FAILURE_REASONS,
  MCP_OAUTH_LOOPBACK_CALLBACK_URL,
  createSlateMcpOAuthLoopback,
  parseMcpOAuthLoopbackAuthorization,
} from "../../source/shared/node/mcp/mcp-oauth-loopback.ts";

let portCursor = 0;
/** A port that no other case in this file picked, released before it is handed out. */
async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    portCursor += 1;
    const candidate = 20000 + ((portCursor * 7919 + process.pid) % 40000);
    const usable = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.listen(candidate, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (usable) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return candidate;
    }
  }
  throw new Error("no free port");
}
/** A request through the plain HTTP client, which this process can reach the loopback listener with. */
async function get(url: string, init?: RequestInit): Promise<Response> {
  return await new Promise<Response>((resolve, reject) => {
    httpGet(url, { method: init?.method ?? "GET" }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve(new Response(body, { status: response.statusCode ?? 0 })));
    }).on("error", reject);
  });
}
function policies() {
  const armed: string[] = [];
  return {
    armed,
    pendingExpiry: { arm: (state: string) => { armed.push(state); return { dispose: () => undefined }; } },
    completionRetry: { runWithRetry: async (work: () => Promise<void>) => await work() },
    bindRetry: { start: () => ({ dispose: () => undefined }) },
  };
}
const authorizationUrl = (callback: string, state: string) => "https://provider.example/authorize?redirect_uri=" + encodeURIComponent(callback) + "&state=" + state;

describe("reading the authorization URL", () => {
  it("accepts an authorization URL whose redirect comes back to this loopback", () => {
    assert.deepEqual(parseMcpOAuthLoopbackAuthorization("https://provider.example/authorize?redirect_uri=" + encodeURIComponent(MCP_OAUTH_LOOPBACK_CALLBACK_URL) + "&state=st-1"), { state: "st-1" });
    assert.deepEqual(parseMcpOAuthLoopbackAuthorization("https://provider.example/authorize?redirect_uri=" + encodeURIComponent("http://127.0.0.1:8787/callback") + "&state=st-2"), { state: "st-2" });
  });

  it("refuses a redirect that is not this loopback", () => {
    const cases = [
      "http://localhost:9999/callback",
      "http://localhost:8787/other",
      "https://localhost:8787/callback",
      "http://example.com:8787/callback",
    ];
    for (const redirect of cases) {
      assert.equal(parseMcpOAuthLoopbackAuthorization("https://provider.example/authorize?redirect_uri=" + encodeURIComponent(redirect) + "&state=st"), null, redirect);
    }
    assert.equal(parseMcpOAuthLoopbackAuthorization("https://provider.example/authorize?state=st"), null);
    assert.equal(parseMcpOAuthLoopbackAuthorization("https://provider.example/authorize?redirect_uri=" + encodeURIComponent("http://localhost:8787/callback") + "&state="), null, "an empty state is not a state");
    assert.equal(parseMcpOAuthLoopbackAuthorization("not a url"), null);
  });
});

describe("the loopback server", () => {
  it("answers a good callback and hands the code on once", async () => {
    const port = await freePort();
    const callback = "http://127.0.0.1:" + port + "/callback";
    const used = policies();
    const completed: Array<{ stateId: string; code: string }> = [];
    const events: any[] = [];
    const loopback = createSlateMcpOAuthLoopback({
      completeOAuth: async (args) => { completed.push(args); },
      log: () => undefined,
      loopbackRedirectUrl: callback,
      pendingExpiry: used.pendingExpiry as never,
      completionRetry: used.completionRetry as never,
      bindRetry: used.bindRetry as never,
      onCallback: (event) => events.push(event),
    });
    try {
      assert.equal(await loopback.registerPendingAuthFromUrl({ authorizationUrl: authorizationUrl(callback, "st-1"), serverName: "Test Server" }), true);
      assert.deepEqual(used.armed, ["st-1"]);
      assert.equal(await loopback.registerPendingAuthFromUrl({ authorizationUrl: authorizationUrl(callback, "st-1"), serverName: "Renamed Server" }), true);
      const response = await get(callback + "?state=st-1&code=abc");
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Test Server/);
      assert.deepEqual(completed, [{ stateId: "st-1", code: "abc" }]);
      assert.equal(events.length, 1);
      assert.deepEqual([events[0].phase, events[0].outcome, events[0].serverName], ["callback_received", "ok", "Test Server"], "the first name registered is the one kept");
      await assert.rejects(get(callback + "?state=st-1&code=abc"), "a state is answered once, and the listener closes when nothing is pending");
      assert.equal(CONNECTOR_OAUTH_CALLBACK_FAILURE_REASONS.length, 4);
    } finally { await loopback.dispose(); }
  });

  it("answers a provider error with the error page and reports the reason", async () => {
    const port = await freePort();
    const callback = "http://127.0.0.1:" + port + "/callback";
    const used = policies();
    const events: any[] = [];
    const loopback = createSlateMcpOAuthLoopback({
      completeOAuth: async () => undefined,
      log: () => undefined,
      loopbackRedirectUrl: callback,
      pendingExpiry: used.pendingExpiry as never,
      completionRetry: used.completionRetry as never,
      bindRetry: used.bindRetry as never,
      onCallback: (event) => events.push(event),
    });
    try {
      await loopback.registerPendingAuthFromUrl({ authorizationUrl: authorizationUrl(callback, "st-err") });
      const response = await get(callback + "?state=st-err&error=denied");
      assert.equal(response.status, 400);
      assert.deepEqual([events[0].phase, events[0].outcome, (events[0].error as any).code], ["callback_received", "failed", "SLATE-E0205"]);
      await assert.rejects(get(callback + "?state=st-err&code="), "the failed state was settled and the listener closed");
    } finally { await loopback.dispose(); }
  });

  it("refuses unknown states, other methods and other paths", async () => {
    const port = await freePort();
    const callback = "http://127.0.0.1:" + port + "/callback";
    const used = policies();
    const loopback = createSlateMcpOAuthLoopback({
      completeOAuth: async () => undefined,
      log: () => undefined,
      loopbackRedirectUrl: callback,
      pendingExpiry: used.pendingExpiry as never,
      completionRetry: used.completionRetry as never,
      bindRetry: used.bindRetry as never,
    });
    try {
      await loopback.registerPendingAuthFromUrl({ authorizationUrl: authorizationUrl(callback, "st-1") });
      assert.equal((await get(callback + "?state=unknown&code=abc")).status, 404);
      assert.equal((await get(callback + "?state=st-1&code=abc", { method: "POST" })).status, 405);
      assert.equal((await get(callback.replace("/callback", "/other") + "?state=st-1&code=abc")).status, 404);
      assert.equal(await loopback.registerPendingAuthFromUrl({ authorizationUrl: "https://provider.example/authorize?state=x" }), false);
    } finally { await loopback.dispose(); }
  });

  it("reports a failed completion where the user can see it, and answers nothing after dispose", async () => {
    const port = await freePort();
    const callback = "http://127.0.0.1:" + port + "/callback";
    const used = policies();
    const logs: string[] = [];
    const events: any[] = [];
    const loopback = createSlateMcpOAuthLoopback({
      completeOAuth: async () => { throw new Error("provider said no"); },
      log: (message) => logs.push(message),
      loopbackRedirectUrl: callback,
      pendingExpiry: used.pendingExpiry as never,
      completionRetry: used.completionRetry as never,
      bindRetry: used.bindRetry as never,
      onCallback: (event) => events.push(event),
    });
    await loopback.registerPendingAuthFromUrl({ authorizationUrl: authorizationUrl(callback, "st-fail") });
    const response = await get(callback + "?state=st-fail&code=abc");
    assert.equal(response.status, 500);
    assert.match(logs[0] ?? "", /loopback OAuth completion failed: provider said no/);
    assert.deepEqual([events[0].outcome, (events[0].error as any).code], ["failed", "SLATE-E0205"]);
    await loopback.dispose();
    assert.equal(await loopback.registerPendingAuthFromUrl({ authorizationUrl: authorizationUrl(callback, "st-after") }), false);
    await assert.rejects(get(callback + "?state=st-after&code=abc"));
  });
});