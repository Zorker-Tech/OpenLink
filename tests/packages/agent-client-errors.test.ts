import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";

import {
  ActionRequiredError,
  AgentError,
  CancelledError,
  NonRetriableError,
  RetriableError,
  classifyError,
} from "../../source/packages/agent-client/errors.ts";
import { ErrorDetails_Error } from "../../source/adapters/interop/proto/generated/aiserver/v1/utils_pb.ts";

function connectError(code: number, details: any[], message = "backend failed", metadata: Record<string, string> = {}) {
  return Object.assign(new Error(message), {
    name: "ConnectError",
    code,
    metadata: { get: (key: string) => metadata[key] ?? null },
    findDetails: () => details,
  }) as never;
}
const detail = (error: ErrorDetails_Error, fields: Record<string, unknown> = {}) => ({ error, details: fields }) as never;

describe("classifying a backend failure", () => {
  it("returns a classified error as it is", () => {
    const original = new RetriableError("already");
    assert.equal(classifyError(original), original);
  });

  it("reads a plain failure as retriable and an abort as cancelled", () => {
    assert.equal(classifyError(new Error("boom")) instanceof RetriableError, true);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    assert.equal(classifyError(abort) instanceof CancelledError, true);
  });

  it("reads a transport failure through a cause chain", () => {
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    assert.equal(classifyError(reset) instanceof RetriableError, true);
    const outer = Object.assign(new Error("outer"), { cause: reset });
    assert.equal(classifyError(outer) instanceof RetriableError, true);
    const errno = Object.assign(new Error("dns"), { code: "ENOTFOUND" });
    assert.equal(classifyError(errno) instanceof RetriableError, true);
  });

  it("turns a cancelled call into a cancelled error unless it is a transport failure", () => {
    assert.equal(classifyError(connectError(Code.Canceled, [])) instanceof CancelledError, true);
    assert.equal(classifyError(connectError(Code.Aborted, [])) instanceof CancelledError, true);
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    assert.equal(classifyError(connectError(Code.Canceled, [], "socket hang up")) instanceof RetriableError, true);
    assert.equal(classifyError(Object.assign(connectError(Code.Canceled, []), { cause: reset })) instanceof RetriableError, true);
  });

  it("makes the failing code sets actionable", () => {
    const login = classifyError(connectError(Code.Unknown, [detail(ErrorDetails_Error.NOT_LOGGED_IN)]));
    assert.equal(login instanceof ActionRequiredError, true);
    assert.equal((login as ActionRequiredError).action, "login");
    const upgrade = classifyError(connectError(Code.Unknown, [detail(ErrorDetails_Error.FREE_USER_USAGE_LIMIT)]));
    assert.equal((upgrade as ActionRequiredError).action, "upgrade");
    const payment = classifyError(connectError(Code.Unknown, [detail(ErrorDetails_Error.USAGE_PRICING_REQUIRED)]));
    assert.equal((payment as ActionRequiredError).action, "payment");
    const config = classifyError(connectError(Code.Unknown, [detail(ErrorDetails_Error.BAD_API_KEY)]));
    assert.equal((config as ActionRequiredError).action, "config");
    const unauthenticated = classifyError(connectError(Code.Unauthenticated, []));
    assert.equal((unauthenticated as ActionRequiredError).action, "login");
  });

  it("uses the backend action and the display info it was given", () => {
    const rejected = classifyError(connectError(Code.Unknown, [detail(ErrorDetails_Error.NOT_LOGGED_IN, { analyticsMetadata: { actionRequired: "reconnect" }, title: "T", detail: "D", isRetryable: true })]));
    assert.equal(rejected instanceof ActionRequiredError, true);
    assert.equal((rejected as ActionRequiredError).action, "reconnect");
    assert.equal(rejected.displayInfo?.title, "T");
    assert.equal(rejected.displayInfo?.detail, "D");
    assert.equal(rejected.displayInfo?.isRetryable, true);
    assert.equal(rejected.displayInfo?.connectCode, Code.Unknown);
    assert.equal(rejected.displayInfo?.errorCode, "authentication");
    assert.equal(rejected.displayInfo?.errorDetails?.actionRequired, "reconnect");
    assert.equal(rejected.displayInfo?.errorDetails?.expected, undefined);
  });

  it("keeps a terminal message and a non-retriable detail terminal", () => {
    assert.equal(classifyError(connectError(Code.Unknown, [detail(ErrorDetails_Error.CUSTOM_MESSAGE)])) instanceof NonRetriableError, true);
    assert.equal(classifyError(connectError(Code.Unknown, [detail(ErrorDetails_Error.NOT_LOGGED_IN, { isRetryable: false })])) instanceof ActionRequiredError, true);
    assert.equal(classifyError(connectError(Code.Unknown, [detail(ErrorDetails_Error.NOT_HIGH_ENOUGH_PERMISSIONS, { isRetryable: false })])) instanceof NonRetriableError, true);
  });

  it("reports the inference error type header and the request id", () => {
    const classified = classifyError(connectError(Code.Unknown, [], "no details", { "x-slate-backend-client-request-error-type": "context_length_exceeded" }), { requestId: "req-1" });
    assert.equal(classified.displayInfo?.inferenceRequestErrorType, "context_length_exceeded");
    assert.equal(classified.requestId, "req-1");
    assert.equal(classified instanceof RetriableError, true);
  });
});
