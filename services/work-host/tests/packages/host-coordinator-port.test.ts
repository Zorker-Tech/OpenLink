import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COORDINATOR_CANCELLED,
  COORDINATOR_CONTROL_CHANNEL,
  COORDINATOR_MAIN_DATA_CHANNEL,
  COORDINATOR_PROTOCOL_VERSION,
  COORDINATOR_TRANSPORT_STATE_FAMILY,
  COORDINATOR_UNKNOWN_METHOD,
  asCoordinatorControlEnvelope,
  asCoordinatorMainDataEnvelope,
  parseCoordinatorBootstrap,
  parseCoordinatorFrame,
} from "../../source/shared/rpc/coordinator-port.ts";

/** The detail sentence a refused frame is reported with, and whether it was refused at all. */
function refusal(value: unknown): string | undefined {
  const result = parseCoordinatorFrame(value);
  return result.accepted ? undefined : result.rejection.detail;
}

/** An accepted frame, as the parser hands it over. */
function accepted(value: unknown): unknown {
  const result = parseCoordinatorFrame(value);
  assert.equal(result.accepted, true, String(refusal(value)));
  return result.accepted ? result.frame : undefined;
}

describe("what the port calls itself", () => {
  it("names its protocol and the two failures a caller acts on", () => {
    assert.equal(COORDINATOR_PROTOCOL_VERSION, 1);
    assert.equal(COORDINATOR_UNKNOWN_METHOD, "unknown-method");
    assert.equal(COORDINATOR_CANCELLED, "cancelled");
    assert.equal(COORDINATOR_TRANSPORT_STATE_FAMILY, "coordinator-transport-state");
    assert.equal(COORDINATOR_CONTROL_CHANNEL, "coordinator-control");
    assert.equal(COORDINATOR_MAIN_DATA_CHANNEL, "coordinator-main-data");
  });
});

describe("the frames a peer may send", () => {
  it("reads a hello and a ready for the version they speak", () => {
    assert.deepEqual(accepted({ kind: "lifecycle", phase: "hello", protocolVersion: 1 }), { kind: "lifecycle", phase: "hello", protocolVersion: 1 });
    assert.deepEqual(accepted({ kind: "lifecycle", phase: "ready", protocolVersion: 2 }), { kind: "lifecycle", phase: "ready", protocolVersion: 2 });
    assert.match(refusal({ kind: "lifecycle", phase: "ready" }) ?? "", /lifecycle\.ready\.protocolVersion must be a number/);
    assert.match(refusal({ kind: "lifecycle", phase: "hello", protocolVersion: "1" }) ?? "", /lifecycle\.hello\.protocolVersion must be a number/);
  });

  it("reads a shutdown for why it is going away", () => {
    assert.deepEqual(accepted({ kind: "lifecycle", phase: "shutdown", reason: "requested", detail: null }), { kind: "lifecycle", phase: "shutdown", reason: "requested", detail: null });
    assert.deepEqual(accepted({ kind: "lifecycle", phase: "shutdown", reason: "protocol-error", detail: "bad tag" }), { kind: "lifecycle", phase: "shutdown", reason: "protocol-error", detail: "bad tag" });
    assert.match(refusal({ kind: "lifecycle", phase: "shutdown", reason: "requested", detail: "why" }) ?? "", /detail must be null for a requested shutdown/);
    assert.match(refusal({ kind: "lifecycle", phase: "shutdown", reason: "protocol-error", detail: "" }) ?? "", /detail must name the breach/);
    assert.match(refusal({ kind: "lifecycle", phase: "shutdown", reason: "because" }) ?? "", /reason must be requested or protocol-error/);
    assert.match(refusal({ kind: "lifecycle", phase: "later" }) ?? "", /lifecycle\.phase must be hello, ready, or shutdown/);
  });

  it("reads a request for its id, its method and an argument that is there even when it is null", () => {
    assert.deepEqual(accepted({ kind: "request", requestId: "r1", method: "read", args: { at: 1 } }), { kind: "request", requestId: "r1", method: "read", args: { at: 1 } });
    assert.deepEqual(accepted({ kind: "request", requestId: "r1", method: "read", args: null }), { kind: "request", requestId: "r1", method: "read", args: null });
    assert.match(refusal({ kind: "request", requestId: "", method: "read", args: null }) ?? "", /request\.requestId must be a non-empty string/);
    assert.match(refusal({ kind: "request", requestId: "r1", method: "", args: null }) ?? "", /request\.method must be a non-empty string/);
    assert.match(refusal({ kind: "request", requestId: "r1", method: "read" }) ?? "", /request\.args is missing/);
  });

  it("reads a cancel for the request it cancels", () => {
    assert.deepEqual(accepted({ kind: "cancel", requestId: "r1" }), { kind: "cancel", requestId: "r1" });
    assert.match(refusal({ kind: "cancel" }) ?? "", /cancel\.requestId must be a non-empty string/);
  });

  it("reads a reply for its outcome, whether it carries a value or a failure", () => {
    assert.deepEqual(accepted({ kind: "reply", requestId: "r1", outcome: { status: "ok", value: undefined } }), { kind: "reply", requestId: "r1", outcome: { status: "ok", value: undefined } });
    assert.deepEqual(accepted({ kind: "reply", requestId: "r1", outcome: { status: "failed", failure: { code: "boom", message: "went wrong" } } }), {
      kind: "reply",
      requestId: "r1",
      outcome: { status: "failed", failure: { code: "boom", message: "went wrong" } },
    });
  });

  it("keeps the transport a failure came over, and leaves it out when it is not named", () => {
    const withTransport = accepted({ kind: "reply", requestId: "r1", outcome: { status: "failed", failure: { code: "boom", message: "x", transportKind: "socket" } } }) as { outcome: { failure: Record<string, unknown> } };
    assert.equal(withTransport.outcome.failure.transportKind, "socket");
    const without = accepted({ kind: "reply", requestId: "r1", outcome: { status: "failed", failure: { code: "boom", message: "x", transportKind: "" } } }) as { outcome: { failure: Record<string, unknown> } };
    assert.equal("transportKind" in without.outcome.failure, false);
  });

  it("refuses a reply whose outcome is not one of the two shapes", () => {
    for (const outcome of [undefined, {}, { status: "ok" }, { status: "other" }, { status: "failed" }, { status: "failed", failure: { code: "", message: "x" } }, { status: "failed", failure: { code: "c" } }]) {
      assert.match(refusal({ kind: "reply", requestId: "r1", outcome }) ?? "", /reply\.outcome is not a valid outcome/);
    }
  });

  it("reads an event for its family and its payload, which may be there and empty", () => {
    assert.deepEqual(accepted({ kind: "event", family: "f", payload: [1] }), { kind: "event", family: "f", payload: [1] });
    assert.deepEqual(accepted({ kind: "event", family: "f", payload: undefined }), { kind: "event", family: "f", payload: undefined });
    assert.match(refusal({ kind: "event", family: "", payload: 1 }) ?? "", /event\.family must be a non-empty string/);
    assert.match(refusal({ kind: "event", family: "f" }) ?? "", /event\.payload is missing/);
  });
});

describe("a frame that is not one", () => {
  it("is refused when it is not an object, and says so", () => {
    for (const value of [null, undefined, 1, "frame", true]) assert.match(refusal(value) ?? "", /frame must be an object/);
  });

  it("is refused when it does not say what it is — an array included, since it is an object without a kind", () => {
    for (const value of [{}, [], { kind: 42 }, { kind: "later" }]) assert.match(refusal(value) ?? "", /frame\.kind must be lifecycle, request, cancel, reply, or event/);
  });

  it("is refused when it says it is something every object already is", () => {
    // A reader table must not answer for names that belong to the object prototype.
    for (const kind of ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"]) {
      assert.match(refusal({ kind }) ?? "", /frame\.kind must be lifecycle, request, cancel, reply, or event/, kind);
    }
    assert.match(refusal({ kind: "lifecycle", phase: "toString" }) ?? "", /lifecycle\.phase must be hello, ready, or shutdown/);
  });
});

describe("the bootstrap a coordinator is started with", () => {
  it("reads where it is, whether it is packaged, and where its data lives", () => {
    assert.deepEqual(parseCoordinatorBootstrap({ processConfig: { appVersion: "1.2.3", isPackaged: true, dataDir: "/data", extra: "ignored" } }), {
      accepted: true,
      bootstrap: { processConfig: { appVersion: "1.2.3", isPackaged: true, dataDir: "/data" } },
    });
  });

  it("refuses one that does not say where it is, what it is, or where its data lives", () => {
    const detail = (value: unknown) => {
      const result = parseCoordinatorBootstrap(value);
      return result.accepted ? undefined : result.rejection.detail;
    };
    assert.equal(detail(null), "bootstrap.processConfig must be an object");
    assert.equal(detail({}), "bootstrap.processConfig must be an object");
    assert.equal(detail({ processConfig: { appVersion: "", isPackaged: true, dataDir: "/d" } }), "bootstrap.processConfig.appVersion must be a non-empty string");
    assert.equal(detail({ processConfig: { appVersion: "1", isPackaged: "yes", dataDir: "/d" } }), "bootstrap.processConfig.isPackaged must be a boolean");
    assert.equal(detail({ processConfig: { appVersion: "1", isPackaged: false, dataDir: "" } }), "bootstrap.processConfig.dataDir must be a non-empty string");
  });
});

describe("the envelopes a frame travels in", () => {
  it("reads a message on the channel it names, and nothing on another", () => {
    assert.deepEqual(asCoordinatorControlEnvelope({ channel: COORDINATOR_CONTROL_CHANNEL, frame: 1 }), { channel: COORDINATOR_CONTROL_CHANNEL, frame: 1 });
    assert.deepEqual(asCoordinatorMainDataEnvelope({ channel: COORDINATOR_MAIN_DATA_CHANNEL, frame: { a: 1 } }), { channel: COORDINATOR_MAIN_DATA_CHANNEL, frame: { a: 1 } });
    assert.equal(asCoordinatorControlEnvelope({ channel: COORDINATOR_MAIN_DATA_CHANNEL, frame: 1 }), null);
    assert.equal(asCoordinatorMainDataEnvelope({ channel: COORDINATOR_CONTROL_CHANNEL, frame: 1 }), null);
  });

  it("reads an envelope with no frame in it as nothing at all", () => {
    assert.equal(asCoordinatorControlEnvelope({ channel: COORDINATOR_CONTROL_CHANNEL }), null);
    assert.equal(asCoordinatorMainDataEnvelope({ channel: COORDINATOR_MAIN_DATA_CHANNEL }), null);
    for (const value of [null, 1, "x", {}, { channel: "other", frame: 1 }]) {
      assert.equal(asCoordinatorControlEnvelope(value), null);
      assert.equal(asCoordinatorMainDataEnvelope(value), null);
    }
  });
});
