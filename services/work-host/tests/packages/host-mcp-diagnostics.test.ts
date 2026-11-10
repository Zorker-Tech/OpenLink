import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXEC_ERROR_CLASS_CAP,
  MCP_ERROR_RESULT_CLASS,
  mcpErrorClassOf,
  pinMcpDiagnosticsReporter,
  recordMcpExecErrorClass,
  reportMcpHostEdgeDegraded,
  reportMcpHostEdgeFailure,
  takeMcpExecErrorClass,
  type McpDiagnostic,
} from "../../source/shared/node/mcp/mcp-diagnostics.ts";

/** An error with a name and whatever else the case needs on it. */
const named = (name: string, fields: Record<string, unknown> = {}) => Object.assign(new Error("boom"), { name, ...fields });

/** Collects what is reported while it is pinned, and nothing while it is not. */
function listener(): { readonly seen: McpDiagnostic[]; readonly reporter: (failure: McpDiagnostic) => void } {
  const seen: McpDiagnostic[] = [];
  return { seen, reporter: (failure) => seen.push(failure) };
}

describe("what a failure is called", () => {
  it("names a connect failure after its code", () => {
    assert.equal(mcpErrorClassOf(named("ConnectError", { code: 14 })), "ConnectError.Unavailable");
    assert.equal(mcpErrorClassOf(named("ConnectError", { code: 8 })), "ConnectError.ResourceExhausted");
    assert.equal(mcpErrorClassOf(named("ConnectError", { code: 1 })), "ConnectError.Canceled");
  });

  it("says undefined for a connect code this build does not know, and for one that is not a number", () => {
    assert.equal(mcpErrorClassOf(named("ConnectError", { code: 99 })), "ConnectError.undefined");
    assert.equal(mcpErrorClassOf(named("ConnectError", { code: "14" })), "ConnectError.undefined");
    assert.equal(mcpErrorClassOf(named("ConnectError")), "ConnectError", "no code on it at all is just an error named ConnectError");
  });

  it("names anything else after the error, and an unnamed error as an error", () => {
    assert.equal(mcpErrorClassOf(named("CustomError", { code: 14 })), "CustomError");
    assert.equal(mcpErrorClassOf(named("")), "Error");
    assert.equal(mcpErrorClassOf(new Error("x")), "Error");
  });

  it("says what was thrown when it was not an error", () => {
    assert.equal(mcpErrorClassOf("a string"), "string");
    assert.equal(mcpErrorClassOf(42), "number");
    assert.equal(mcpErrorClassOf(null), "object");
    assert.equal(mcpErrorClassOf(undefined), "undefined");
    assert.equal(mcpErrorClassOf({ name: "ConnectError", code: 14 }), "object");
  });
});

describe("reporting before anyone is listening", () => {
  it("holds the first failures and hands them over in order when a listener arrives", () => {
    pinMcpDiagnosticsReporter(null);
    for (let index = 0; index < 5; index += 1) reportMcpHostEdgeFailure(`leg${index}`, named("Error"));
    reportMcpHostEdgeDegraded("degraded", "some_class");
    const { seen, reporter } = listener();
    pinMcpDiagnosticsReporter(reporter);
    assert.deepEqual(seen, [
      { leg: "leg0", errorClass: "Error" },
      { leg: "leg1", errorClass: "Error" },
      { leg: "leg2", errorClass: "Error" },
      { leg: "leg3", errorClass: "Error" },
      { leg: "leg4", errorClass: "Error" },
      { leg: "degraded", errorClass: "some_class" },
    ]);
  });

  it("holds no more than thirty-two, and drops what comes after", () => {
    pinMcpDiagnosticsReporter(null);
    for (let index = 0; index < 40; index += 1) reportMcpHostEdgeFailure(`leg${index}`, named("Error"));
    const { seen, reporter } = listener();
    pinMcpDiagnosticsReporter(reporter);
    assert.equal(seen.length, 32);
    assert.equal(seen[0]?.leg, "leg0");
    assert.equal(seen.at(-1)?.leg, "leg31");
  });

  it("replays what it held once, not every time a listener arrives", () => {
    pinMcpDiagnosticsReporter(null);
    reportMcpHostEdgeFailure("held", named("Error"));
    const first = listener();
    pinMcpDiagnosticsReporter(first.reporter);
    const second = listener();
    pinMcpDiagnosticsReporter(second.reporter);
    assert.deepEqual(first.seen.map((failure) => failure.leg), ["held"]);
    assert.deepEqual(second.seen, []);
  });

  it("drops what was held when it is pinned with nobody", () => {
    pinMcpDiagnosticsReporter(null);
    reportMcpHostEdgeFailure("held", named("Error"));
    pinMcpDiagnosticsReporter(null);
    const { seen, reporter } = listener();
    pinMcpDiagnosticsReporter(reporter);
    assert.deepEqual(seen, []);
  });

  it("reports a degraded leg with the class it was given, unchanged", () => {
    const { seen, reporter } = listener();
    pinMcpDiagnosticsReporter(reporter);
    reportMcpHostEdgeDegraded("degraded", "");
    reportMcpHostEdgeDegraded("degraded", "some_class");
    assert.deepEqual(seen, [{ leg: "degraded", errorClass: "" }, { leg: "degraded", errorClass: "some_class" }]);
    pinMcpDiagnosticsReporter(null);
  });

  it("reports straight through while a listener is pinned", () => {
    const { seen, reporter } = listener();
    pinMcpDiagnosticsReporter(reporter);
    reportMcpHostEdgeFailure("live", named("ConnectError", { code: 14 }));
    assert.deepEqual(seen, [{ leg: "live", errorClass: "ConnectError.Unavailable" }]);
    pinMcpDiagnosticsReporter(null);
  });
});

describe("remembering how a tool call ended", () => {
  it("takes the class of the error once, and answers with the fallback afterwards", () => {
    recordMcpExecErrorClass("call-1", named("ConnectError", { code: 14 }));
    assert.equal(takeMcpExecErrorClass("call-1"), "ConnectError.Unavailable");
    assert.equal(takeMcpExecErrorClass("call-1"), MCP_ERROR_RESULT_CLASS);
    assert.equal(takeMcpExecErrorClass("never-recorded"), MCP_ERROR_RESULT_CLASS);
    assert.equal(MCP_ERROR_RESULT_CLASS, "mcp_error_result");
  });

  it("ignores a tool call with no id", () => {
    recordMcpExecErrorClass("", named("Error"));
    assert.equal(takeMcpExecErrorClass(""), MCP_ERROR_RESULT_CLASS);
  });

  it("forgets the oldest once it holds as many as it will", () => {
    for (let index = 0; index < EXEC_ERROR_CLASS_CAP + 2; index += 1) recordMcpExecErrorClass(`call-${index}`, named("Error"));
    assert.equal(takeMcpExecErrorClass("call-0"), MCP_ERROR_RESULT_CLASS);
    assert.equal(takeMcpExecErrorClass("call-1"), MCP_ERROR_RESULT_CLASS);
    assert.equal(takeMcpExecErrorClass("call-2"), "Error");
    assert.equal(takeMcpExecErrorClass(`call-${EXEC_ERROR_CLASS_CAP + 1}`), "Error");
    assert.equal(EXEC_ERROR_CLASS_CAP, 128);
  });
});
