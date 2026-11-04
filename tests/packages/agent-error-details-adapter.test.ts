import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createInteropExtensionHostTimeoutError,
  hasInteropExtensionHostTimeoutMarker,
  projectAgentErrorDetails,
  readInteropAgentErrorContext,
  readInteropErrorDetailTexts,
} from "../../source/adapters/interop/agent/agent-error-details-adapter.ts";
import { CustomErrorDetails, ErrorAnalyticsMetadata, ErrorDetails, ErrorDetails_Error } from "../../source/adapters/interop/proto/generated/aiserver/v1/utils_pb.ts";
import { Code } from "@connectrpc/connect";

function remoteFailure(details: readonly ErrorDetails[], fields: { readonly cause?: unknown; readonly header?: string } = {}) {
  return {
    cause: fields.cause,
    metadata: { get: (name: string) => name === "x-cursor-inference-request-error-type" ? fields.header ?? null : null },
    findDetails: () => details,
  };
}

describe("remote error projection", () => {
  it("maps the supported wire categories into Slate-owned codes", () => {
    const cases = [
      [2, "authentication"],
      [18, "authentication"],
      [11, "authentication"],
      [12, "authentication"],
      [3, "authentication"],
      [38, "authentication"],
      [46, "authentication"],
      [47, "authentication"],
      [9, "usage-limit"],
      [7, "usage-limit"],
      [23, "usage-limit"],
      [10, "usage-limit"],
      [8, "usage-limit"],
      [50, "usage-limit"],
      [51, "usage-limit"],
      [22, "usage-limit"],
      [44, "payment-required"],
      [45, "payment-required"],
      [1, "configuration-required"],
      [42, "configuration-required"],
      [21, "cancelled"],
      [35, "cancelled"],
      [29, "custom-message"],
    ] as const;

    for (const [wireCode, code] of cases) {
      assert.equal(projectAgentErrorDetails(new ErrorDetails({ error: wireCode })).code, code);
    }
    assert.equal(projectAgentErrorDetails(new ErrorDetails({ error: 999 as ErrorDetails["error"] })).code, "other");
  });

  it("copies only Slate display fields from a remote detail", () => {
    const details = projectAgentErrorDetails(new ErrorDetails({
      error: 2,
      isExpected: true,
      details: new CustomErrorDetails({
        title: "Sign in",
        detail: "Reconnect to continue.",
        isRetryable: false,
        analyticsMetadata: new ErrorAnalyticsMetadata({ actionRequired: "reconnect" }),
      }),
    }));

    assert.deepEqual(details, {
      code: "authentication",
      title: "Sign in",
      detail: "Reconnect to continue.",
      isRetryable: false,
      actionRequired: "reconnect",
      expected: true,
    });
  });

  it("prefers direct details, falls back to the cause, and reads the inference hint", () => {
    const cause = remoteFailure([new ErrorDetails({ error: 9 })]);
    const context = readInteropAgentErrorContext(remoteFailure(
      [new ErrorDetails({ error: 2 }), new ErrorDetails({ error: 44 })],
      { cause, header: "capacity" },
    ));
    assert.equal(context.details?.code, "authentication");
    assert.equal(context.inferenceRequestErrorType, "capacity");

    const causeContext = readInteropAgentErrorContext(remoteFailure([], { cause }));
    assert.equal(causeContext.details?.code, "usage-limit");
  });

  it("treats unreadable cause details as absent", () => {
    const causeContext = readInteropAgentErrorContext(remoteFailure([], {
      cause: { findDetails: () => { throw new Error("unavailable"); } },
    }));
    assert.equal(causeContext.details, undefined);
  });

  it("keeps the extension-host timeout marker and its display text inside the wire adapter", () => {
    const cause = new Error("stream did not start");
    const failure = createInteropExtensionHostTimeoutError({
      title: "Workspace Disconnected",
      detail: "Reload and try again.",
      cause,
    });

    assert.equal(failure.code, Code.DeadlineExceeded);
    assert.equal(failure.cause, cause);
    assert.equal(hasInteropExtensionHostTimeoutMarker(failure), true);
    assert.deepEqual(readInteropErrorDetailTexts(failure), [
      { title: "Workspace Disconnected", detail: "Reload and try again." },
    ]);
    assert.equal(hasInteropExtensionHostTimeoutMarker(new ErrorDetails({ error: ErrorDetails_Error.NETWORK_ERROR })), false);
  });
});
