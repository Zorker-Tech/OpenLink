import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";

import {
  buildMdmSignInPolicyHeaderValue,
  MDM_SIGN_IN_POLICY_HEADER_NAME,
  SIGN_IN_POLICY_VIOLATION_ERROR,
  SIGN_IN_POLICY_VIOLATION_MESSAGE,
  SignInPolicyViolationError,
} from "../../source/packages/config/auth/mdm-sign-in-policy.ts";

const previousProxy = {
  upper: process.env.HTTPS_PROXY,
  lower: process.env.https_proxy,
};
const previousPolicy = process.env.SLATE_MDM_SIGN_IN_POLICY_JSON;
delete process.env.HTTPS_PROXY;
delete process.env.https_proxy;
process.env.SLATE_MDM_SIGN_IN_POLICY_JSON = JSON.stringify({
  SignInEnforcement: true,
  AllowedOrganizationIds: "42",
});

const login = await import("../../source/packages/config/auth/login.ts");

after(() => {
  if (previousProxy.upper === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = previousProxy.upper;
  if (previousProxy.lower === undefined) delete process.env.https_proxy;
  else process.env.https_proxy = previousProxy.lower;
  if (previousPolicy === undefined) delete process.env.SLATE_MDM_SIGN_IN_POLICY_JSON;
  else process.env.SLATE_MDM_SIGN_IN_POLICY_JSON = previousPolicy;
});

interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly policyHeader: string | undefined;
  readonly body: string;
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function withServer(
  handle: (request: IncomingMessage, response: ServerResponse, body: string, seen: SeenRequest[]) => void | Promise<void>,
  run: (baseUrl: string, seen: SeenRequest[]) => Promise<void>,
): Promise<void> {
  const seen: SeenRequest[] = [];
  const server = createServer((request, response) => {
    void requestBody(request).then((body) => {
      seen.push({
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: Array.isArray(request.headers.authorization) ? request.headers.authorization.join(",") : request.headers.authorization,
        policyHeader: Array.isArray(request.headers[MDM_SIGN_IN_POLICY_HEADER_NAME])
          ? request.headers[MDM_SIGN_IN_POLICY_HEADER_NAME]?.join(",")
          : request.headers[MDM_SIGN_IN_POLICY_HEADER_NAME],
        body,
      });
      return handle(request, response, body, seen);
    }).catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`, seen);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error == null ? resolve() : reject(error)));
  }
}

describe("building a browser sign-in request", () => {
  it("uses a fresh verifier, its SHA-256 challenge, and the configured website path", () => {
    const auth = login.generateAuthParams("slate-app", "https://login.example/path");
    const challenge = createHash("sha256").update(auth.verifier).digest("base64url");
    const url = new URL(auth.loginUrl);
    assert.match(auth.uuid, /^[0-9a-f-]{36}$/i);
    assert.equal(Buffer.from(auth.verifier, "base64url").length, 32);
    assert.equal(auth.challenge, challenge);
    assert.equal(url.toString(), `https://login.example/path/loginDeepControl?challenge=${challenge}&uuid=${auth.uuid}&mode=login&redirectTarget=slate-app`);
  });

  it("opens the login link before polling and passes the returned token pair through", async () => {
    const order: string[] = [];
    const tokens = { accessToken: "access", refreshToken: "refresh" };
    await withServer(async (_request, response, _body, seen) => {
      order.push("poll");
      respond(response, 200, tokens);
      assert.equal(seen.length, 1);
    }, async (baseUrl, seen) => {
      const manager = new login.LoginManager({ redirectTarget: "slate-app", apiUrl: `${baseUrl}/`, websiteUrl: "https://login.example/" });
      let finishOpening: (() => void) | undefined;
      const opening = new Promise<void>((resolve) => { finishOpening = resolve; });
      const pendingLogin = manager.login({ openUrl: async (url) => {
        order.push("open");
        const loginUrl = new URL(url);
        assert.equal(loginUrl.pathname, "/loginDeepControl");
        assert.equal(loginUrl.searchParams.get("redirectTarget"), "slate-app");
        assert.equal(loginUrl.searchParams.get("mode"), "login");
        await opening;
        order.push("opened");
      } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(order, ["open"]);
      assert.equal(seen.length, 0, "the status endpoint waits until the browser open finishes");
      finishOpening?.();
      const result = await pendingLogin;
      assert.deepEqual(result, tokens);
      assert.deepEqual(order, ["open", "opened", "poll"]);
      assert.equal(seen[0]?.method, "GET");
      assert.equal(new URL(seen[0]!.url, baseUrl).pathname, "/auth/poll");
      assert.equal(seen[0]?.policyHeader, buildMdmSignInPolicyHeaderValue({ SignInEnforcement: true, AllowedOrganizationIds: "42" }));
    });
  });
});

describe("polling for the browser sign-in result", () => {
  it("returns no result when already aborted without sending a request", async () => {
    const controller = new AbortController();
    controller.abort();
    let requests = 0;
    await withServer(async (_request, response) => {
      requests += 1;
      respond(response, 200, { accessToken: "a", refreshToken: "r" });
    }, async (apiBaseUrl) => {
      assert.equal(await login.pollAuthenticationStatus({ uuid: "u", verifier: "v", apiBaseUrl, signal: controller.signal }), null);
    });
    assert.equal(requests, 0);
  });

  it("retries a not-found session and accepts a later valid token result", async () => {
    const tokens = { accessToken: "new-access", refreshToken: "new-refresh" };
    await withServer(async (_request, response, _body, seen) => {
      if (seen.length === 1) respond(response, 404, {});
      else respond(response, 200, tokens);
    }, async (apiBaseUrl, seen) => {
      const result = await login.pollAuthenticationStatus({ uuid: "uuid-1", verifier: "verifier-1", apiBaseUrl });
      assert.deepEqual(result, tokens);
      assert.equal(seen.length, 2);
      assert.equal(new URL(seen[0]!.url, apiBaseUrl).searchParams.get("uuid"), "uuid-1");
      assert.equal(new URL(seen[0]!.url, apiBaseUrl).searchParams.get("verifier"), "verifier-1");
      assert.equal(seen[0]?.method, "GET");
    });
  });

  it("rejects a successful response that does not contain both token strings", async () => {
    await withServer(async (_request, response) => {
      respond(response, 200, { accessToken: "access", refreshToken: 9 });
    }, async (apiBaseUrl, seen) => {
      assert.equal(await login.pollAuthenticationStatus({ uuid: "u", verifier: "v", apiBaseUrl }), null);
      assert.equal(seen.length, 1);
    });
  });

  it("stops after three consecutive network errors", async () => {
    await withServer(async (_request, response) => {
      respond(response, 503, { error: "unavailable" });
    }, async (apiBaseUrl, seen) => {
      assert.equal(await login.pollAuthenticationStatus({ uuid: "u", verifier: "v", apiBaseUrl }), null);
      assert.equal(seen.length, 3);
    });
  });

  it("raises the device-policy error instead of retrying a forbidden sign-in", async () => {
    await withServer(async (_request, response) => {
      respond(response, 403, { error: SIGN_IN_POLICY_VIOLATION_ERROR });
    }, async (apiBaseUrl, seen) => {
      await assert.rejects(
        () => login.pollAuthenticationStatus({ uuid: "u", verifier: "v", apiBaseUrl }),
        (error: unknown) => error instanceof SignInPolicyViolationError && error.message === SIGN_IN_POLICY_VIOLATION_MESSAGE,
      );
      assert.equal(seen.length, 1);
    });
  });
});

describe("exchanging a user API key", () => {
  it("posts an empty object with bearer auth and returns only a valid token pair", async () => {
    const tokens = { accessToken: "access", refreshToken: "refresh" };
    await withServer(async (_request, response) => { respond(response, 200, tokens); }, async (apiBaseUrl, seen) => {
      assert.deepEqual(await login.exchangeApiKeyForTokens("api-key", { endpoint: `${apiBaseUrl}/` }), tokens);
      assert.equal(seen[0]?.method, "POST");
      assert.equal(new URL(seen[0]!.url, apiBaseUrl).pathname, "/auth/exchange_user_api_key");
      assert.equal(seen[0]?.authorization, "Bearer api-key");
      assert.deepEqual(JSON.parse(seen[0]!.body), {});
    });
  });

  it("returns null for refused client credentials, raises network errors for server failures, and preserves policy violations", async () => {
    await withServer(async (_request, response) => { respond(response, 401, { error: "invalid" }); }, async (endpoint) => {
      assert.equal(await login.exchangeApiKeyForTokens("bad", { endpoint }), null);
    });
    await withServer(async (_request, response) => { respond(response, 500, {}); }, async (endpoint) => {
      await assert.rejects(() => login.exchangeApiKeyForTokens("key", { endpoint }), (error: unknown) =>
        error instanceof login.AuthNetworkError && error.cause instanceof Error && /HTTP 500/.test(error.cause.message));
    });
    await withServer(async (_request, response) => { respond(response, 403, { error: SIGN_IN_POLICY_VIOLATION_ERROR }); }, async (endpoint) => {
      await assert.rejects(() => login.exchangeApiKeyForTokens("key", { endpoint }), SignInPolicyViolationError);
    });
  });
});

describe("network failures while signing in", () => {
  it("redacts credentials from a configured proxy when it describes a network error", () => {
    const oldUpper = process.env.HTTPS_PROXY;
    const oldLower = process.env.https_proxy;
    process.env.HTTPS_PROXY = "http://alice:secret@proxy.example:8080";
    delete process.env.https_proxy;
    try {
      const error = new login.AuthNetworkError(new Error("offline"));
      assert.equal(error.name, "AuthNetworkError");
      assert.match(error.message, /proxy\.example:8080/);
      assert.doesNotMatch(error.message, /alice|secret/);
    } finally {
      if (oldUpper === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = oldUpper;
      if (oldLower === undefined) delete process.env.https_proxy;
      else process.env.https_proxy = oldLower;
    }
  });
});
