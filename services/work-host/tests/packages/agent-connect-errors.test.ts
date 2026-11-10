import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Code, ConnectError } from "@connectrpc/connect";

import {
  getConnectErrorCode,
  isAgentStreamStartTimeoutError,
  isAgentStreamStartTimeoutRecoveryTurnError,
  maybeCreateAgentStreamStartTimeoutTurnError,
  maybeNormalizeExecBoundaryError,
} from "../../source/packages/agent/tools/connect-errors.ts";
import {
  CustomToolCallError,
  RetryableToolEnvironmentOrchestrationError,
  ToolCallAbortedError,
  ToolErrorClassification,
} from "../../source/packages/agent/tools/tool-errors.ts";
import { ErrorDetails, ErrorDetails_Error } from "../../source/adapters/interop/proto/generated/aiserver/v1/utils_pb.ts";

const named = (name: string, message = "boom") => Object.assign(new Error(message), { name });
const wrapped = (message: string, cause: unknown) => Object.assign(new Error(message), { cause });
const timeoutError = () => named("AgentExecStreamStartTimeoutError", "no stream");
const timeoutConnectError = () => new ConnectError("timed out", Code.DeadlineExceeded, undefined, [
  new ErrorDetails({ error: ErrorDetails_Error.EXTENSION_HOST_TIMEOUT, details: { title: "Workspace Disconnected", isRetryable: false } }),
]);

describe("normalizing execution-boundary failures", () => {
  it("turns an aborted signal into an aborted tool call", () => {
    const failure = new Error("signal is aborted without reason");
    const normalized = maybeNormalizeExecBoundaryError(failure) as ToolCallAbortedError;
    assert.equal(normalized instanceof ToolCallAbortedError, true);
    assert.equal(normalized.cause, failure);
  });

  it("turns a disposed or missing backend into a non-retryable custom error", () => {
    for (const name of ["ExecBackendUnavailableError", "ControlledExecDisposedError", "AgentExecStreamStartTimeoutError"]) {
      const normalized = maybeNormalizeExecBoundaryError(named(name)) as CustomToolCallError;
      assert.equal(normalized instanceof CustomToolCallError, true, name);
      assert.equal(normalized.classification, ToolErrorClassification.EXEC_BACKEND_UNAVAILABLE, name);
      assert.equal(normalized.modelVisibleErrorMessage.includes("Do not retry"), true);
    }
    const byText = maybeNormalizeExecBoundaryError(wrapped("outer", new Error("execution runtime disposed"))) as CustomToolCallError;
    assert.equal(byText instanceof CustomToolCallError, true);
  });

  it("turns an unreachable environment into a retryable orchestration error", () => {
    for (const message of ["object not found: pod", "exec-daemon is unreachable", "bridge transport is closed", "execution environment has become unreachable"]) {
      const normalized = maybeNormalizeExecBoundaryError(wrapped("outer", new Error(message)));
      assert.equal(normalized instanceof RetryableToolEnvironmentOrchestrationError, true, message);
    }
  });

  it("classifies the transport codes it knows", () => {
    const deadline = maybeNormalizeExecBoundaryError(new ConnectError("late", Code.DeadlineExceeded)) as CustomToolCallError;
    assert.equal(deadline.classification, ToolErrorClassification.OTHER_ERROR);
    assert.equal(deadline.clientVisibleErrorMessage.includes("may be temporary"), true);

    const rateLimited = maybeNormalizeExecBoundaryError(new ConnectError("slow down: rate limit", Code.ResourceExhausted)) as CustomToolCallError;
    assert.equal(rateLimited.classification, ToolErrorClassification.PROVIDER_ERROR);
    assert.equal(rateLimited.clientVisibleErrorMessage.includes("rate limited"), true);

    const exhausted = maybeNormalizeExecBoundaryError(new ConnectError("quota", Code.ResourceExhausted)) as CustomToolCallError;
    assert.equal(exhausted.classification, ToolErrorClassification.OTHER_ERROR);

    const unavailable = maybeNormalizeExecBoundaryError(new ConnectError("down", Code.Unavailable)) as CustomToolCallError;
    assert.equal(unavailable.clientVisibleErrorMessage.includes("temporarily unavailable"), true);

    const missing = maybeNormalizeExecBoundaryError(new ConnectError("gone", Code.NotFound)) as CustomToolCallError;
    assert.equal(missing.clientVisibleErrorMessage.includes("not found"), true);

    const canceled = maybeNormalizeExecBoundaryError(new ConnectError("stop", Code.Canceled)) as CustomToolCallError;
    assert.equal(canceled.classification, ToolErrorClassification.ABORTED);
    assert.equal(canceled.clientVisibleErrorMessage, "Aborted");
  });

  it("leaves a failure it cannot classify alone", () => {
    const plain = new Error("something unrelated");
    assert.equal(maybeNormalizeExecBoundaryError(plain), plain);
    assert.equal(maybeNormalizeExecBoundaryError("text"), "text");
  });
});

describe("stream-start timeouts", () => {
  it("creates a non-retryable turn error with extension-host details", () => {
    const created = maybeCreateAgentStreamStartTimeoutTurnError(timeoutError());
    assert.equal(created instanceof ConnectError, true);
    assert.equal(created!.code, Code.DeadlineExceeded);
    const details = created!.findDetails(ErrorDetails) as ErrorDetails[];
    assert.equal(details[0]!.error, ErrorDetails_Error.EXTENSION_HOST_TIMEOUT);
    assert.equal(details[0]!.details?.isRetryable, false);
    assert.equal(maybeCreateAgentStreamStartTimeoutTurnError(new Error("other")), undefined);
  });

  it("recognizes the timeout name and the recovery error", () => {
    assert.equal(isAgentStreamStartTimeoutError(timeoutError()), true);
    assert.equal(isAgentStreamStartTimeoutError(new Error("x")), false);
    assert.equal(isAgentStreamStartTimeoutRecoveryTurnError(timeoutError()), true);
    assert.equal(isAgentStreamStartTimeoutRecoveryTurnError(timeoutConnectError()), true);
    assert.equal(isAgentStreamStartTimeoutRecoveryTurnError(new ConnectError("x", Code.DeadlineExceeded)), false);
    assert.equal(isAgentStreamStartTimeoutRecoveryTurnError(new Error("x")), false);
  });
});

describe("reading a connect code out of a failure", () => {
  it("reads the message prefix, the stack, and the words used instead", () => {
    assert.equal(getConnectErrorCode(new Error("[invalid_argument] bad request")), Code.InvalidArgument);
    assert.equal(getConnectErrorCode(new Error("[resource_exhausted] slow down")), Code.ResourceExhausted);
    assert.equal(getConnectErrorCode(Object.assign(new Error("x"), { stack: "Error\n  ConnectError: [not_found] missing" })), Code.NotFound);
    assert.equal(getConnectErrorCode(new Error("user aborted request")), Code.Aborted);
    assert.equal(getConnectErrorCode(new Error("canceled")), Code.Canceled);
    assert.equal(getConnectErrorCode(new Error("request cancelled")), Code.Canceled);
    assert.equal(getConnectErrorCode(new Error("unrelated")), undefined);
    assert.equal(getConnectErrorCode("text"), undefined);
    assert.equal(getConnectErrorCode(undefined), undefined);
  });
});
