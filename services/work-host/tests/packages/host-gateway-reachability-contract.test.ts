import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DeadlineExceededError } from "../../source/host/extensions/scheduling.ts";
import {
  GATEWAY_ACCESS_DENIED_MESSAGE_MARKER,
  GATEWAY_BOX_BLOCKED_PREFIX,
  GATEWAY_NO_STORAGE_MESSAGE_MARKER,
  SLATE_CLIENT_PAUSE_BLOCKED_MESSAGE,
} from "../../source/shared/gateway-reachability.ts";
import {
  SlateGatewayUnreachableError,
  classifyBaseUrlKind,
  classifyGatewayError,
  classifyGatewayFetchFailure,
  classifyStreamDown,
  outcomeForHttpStatus,
  type GatewayReachabilityOutcome,
} from "../../source/coordinator/gateway/gateway-reachability.ts";

function withCause(message: string, cause: unknown): Error {
  return new Error(message, { cause });
}

describe("gateway reachability behavior contract", () => {
  it("maps HTTP statuses to only the outcomes callers can act on", () => {
    assert.equal(outcomeForHttpStatus(500), "http_5xx");
    assert.equal(outcomeForHttpStatus(503), "http_5xx");
    assert.equal(outcomeForHttpStatus(401), "access_denied");
    assert.equal(outcomeForHttpStatus(403), "access_denied");
    for (const status of [200, 404, 499]) assert.equal(outcomeForHttpStatus(status), undefined);
  });

  it("classifies storage, box, and access markers through causes before network errno", () => {
    const storage = withCause("outer", Object.assign(new Error(GATEWAY_NO_STORAGE_MESSAGE_MARKER), { code: "ECONNREFUSED" }));
    assert.equal(classifyGatewayFetchFailure(storage).outcome, "no_storage");

    const blocked = withCause("outer", new Error(`${GATEWAY_BOX_BLOCKED_PREFIX}reason`));
    assert.equal(classifyGatewayFetchFailure(blocked).outcome, "box_blocked");

    const denied = withCause("outer", new Error(GATEWAY_ACCESS_DENIED_MESSAGE_MARKER));
    assert.equal(classifyGatewayFetchFailure(denied).outcome, "access_denied");

    const multiple = withCause(
      GATEWAY_ACCESS_DENIED_MESSAGE_MARKER,
      new Error(`${GATEWAY_BOX_BLOCKED_PREFIX}reason`, { cause: new Error(GATEWAY_NO_STORAGE_MESSAGE_MARKER) }),
    );
    assert.equal(classifyGatewayFetchFailure(multiple).outcome, "no_storage");
  });

  it("classifies refused, DNS, timeout and otherwise unrecognized failures", () => {
    for (const code of ["ECONNREFUSED"]) {
      assert.equal(classifyGatewayFetchFailure(Object.assign(new Error("connect"), { code })).outcome, "refused");
    }
    for (const code of ["ENOTFOUND", "EAI_AGAIN"]) {
      assert.equal(classifyGatewayFetchFailure(Object.assign(new Error("lookup"), { code })).outcome, "dns");
    }
    assert.equal(classifyGatewayFetchFailure(Object.assign(new Error("late"), { code: "ETIMEDOUT" })).outcome, "timeout");
    assert.equal(classifyGatewayFetchFailure(new Error("ordinary network failure")).outcome, "network");
    assert.deepEqual(classifyGatewayFetchFailure(undefined), { outcome: "network", causeSummary: "unknown" });
  });

  it("recognizes deadline, abort, timeout-name, timeout-code and nested timeout signals", () => {
    assert.equal(classifyGatewayFetchFailure(new DeadlineExceededError("gateway")).outcome, "timeout");
    assert.equal(classifyGatewayFetchFailure(Object.assign(new Error("cancel"), { name: "AbortError" })).outcome, "timeout");
    assert.equal(classifyGatewayFetchFailure(Object.assign(new Error("late"), { name: "CustomTimeoutError" })).outcome, "timeout");
    assert.equal(classifyGatewayFetchFailure(Object.assign(new Error("late"), { code: "ERR_TIMEOUT" })).outcome, "timeout");
    assert.equal(classifyGatewayFetchFailure(withCause("wrapped", new Error("late", { cause: new DeadlineExceededError("request") }))).outcome, "timeout");
  });

  it("walks cyclic cause chains safely and retains a useful top-level summary", () => {
    const cyclic = Object.assign(new Error("wrapped"), { code: "EAI_AGAIN" }) as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    assert.deepEqual(classifyGatewayFetchFailure(cyclic), { outcome: "dns", causeSummary: "Error/EAI_AGAIN" });
  });

  it("preserves explicit unreachable-error fields when classifying a known error", () => {
    const cause = new Error("socket reset");
    const error = new SlateGatewayUnreachableError("http_5xx", "gateway replied", {
      cause,
      httpStatus: 502,
      causeSummary: "HttpError/502",
      attemptedBaseUrl: "https://gateway.test",
      isPreDispatch: true,
    });
    assert.equal(error.name, "SlateGatewayUnreachableError");
    assert.equal(error.cause, cause);
    assert.deepEqual(classifyGatewayError(error), {
      outcome: "http_5xx",
      causeSummary: "HttpError/502",
      httpStatus: 502,
    });
  });

  it("keeps errno found below a wrapper in the cause summary", () => {
    const wrapped = withCause("request failed", Object.assign(new Error("name lookup"), { code: "ENOTFOUND" }));
    assert.deepEqual(classifyGatewayFetchFailure(wrapped), {
      outcome: "dns",
      causeSummary: "Error/ENOTFOUND",
    });
  });

  it("chooses stream-down reasons in pause, stall, forced, then fetch-failure order", () => {
    assert.deepEqual(classifyStreamDown({ clientPaused: true, stalled: true, forced: true, devInducedOffline: true, error: new Error("x") }), {
      reason: "box_blocked", cause: "client-paused",
    });
    assert.deepEqual(classifyStreamDown({ clientPaused: false, stalled: true, forced: true, devInducedOffline: false, error: new Error("x") }), {
      reason: "stall-timeout", cause: null,
    });
    assert.deepEqual(classifyStreamDown({ clientPaused: false, stalled: false, forced: true, devInducedOffline: false, error: new Error("x") }), {
      reason: "forced-reconnect", cause: null,
    });
    assert.deepEqual(classifyStreamDown({ clientPaused: false, stalled: false, forced: false, devInducedOffline: true, error: new Error("x") }), {
      reason: "forced-reconnect", cause: "dev-induced-offline",
    });
    assert.deepEqual(classifyStreamDown({ clientPaused: false, stalled: false, forced: false, devInducedOffline: false, error: new DeadlineExceededError("stream") }), {
      reason: "timeout", cause: "DeadlineExceededError",
    });
  });

  it("classifies loopback and external base URLs without accepting malformed input as a proxy", () => {
    assert.equal(classifyBaseUrlKind(undefined), "unknown");
    assert.equal(classifyBaseUrlKind(null), "unknown");
    assert.equal(classifyBaseUrlKind(""), "unknown");
    assert.equal(classifyBaseUrlKind("not a url"), "unknown");
    for (const url of ["http://127.0.0.1:3000", "https://localhost", "http://[::1]:80"]) {
      assert.equal(classifyBaseUrlKind(url), "loopback", url);
    }
    assert.equal(classifyBaseUrlKind("https://gateway.example"), "pod_proxy");
  });

  it("keeps the gateway-blocked message marker available to callers", () => {
    assert.equal(classifyGatewayFetchFailure(new Error(SLATE_CLIENT_PAUSE_BLOCKED_MESSAGE)).outcome, "box_blocked");
  });

  it("keeps the outcome vocabulary closed over its declared values", () => {
    const outcomes: GatewayReachabilityOutcome[] = ["no_storage", "box_blocked", "access_denied", "refused", "dns", "timeout", "network", "http_5xx"];
    assert.equal(new Set(outcomes).size, 8);
  });
});
