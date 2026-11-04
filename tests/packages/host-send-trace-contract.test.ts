import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  SLATE_TURN_ROOT_SPAN_NAME,
  adoptRemoteParent,
  beginGatewayCommandTrace,
  beginSendTrace,
  beginTurnTrace,
  markTurnTraceError,
  resolveTurnTraceOutcome,
  resolveTurnTraceSampleRatio,
  resolveTurnTraceType,
  setHostTraceFactory,
  setTurnTraceAttributes,
  setTurnTraceHostBundleVersion,
  traceSendPhase,
  type HostTrace,
  type TraceFactory,
  type TraceSpan,
} from "../../source/host/send-trace-host.ts";
import { parseTraceparent } from "../../source/shared/observability/send-trace.ts";

const validParent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";

function spanRecorder(context?: unknown) {
  const calls: Array<[string, ...unknown[]]> = [];
  const span: TraceSpan = {
    setAttribute: (key, value) => calls.push(["attribute", key, value]),
    recordException: (error) => calls.push(["exception", error]),
    setStatus: (status) => calls.push(["status", status]),
    end: () => calls.push(["end"]),
  };
  return { trace: { span, context } as HostTrace, calls };
}

afterEach(() => {
  setHostTraceFactory(undefined as never);
  setTurnTraceHostBundleVersion(undefined);
});

describe("host send trace behavior contract", () => {
  it("adopts only valid remote parents and names send and gateway spans", () => {
    const created: Array<{ name: string; traceparent?: string }> = [];
    const recorder = spanRecorder();
    setHostTraceFactory((options) => { created.push(options); return recorder.trace; });

    assert.equal(beginSendTrace(validParent), recorder.trace);
    assert.equal(beginGatewayCommandTrace({ traceparent: validParent, method: "sendMessage" }), recorder.trace);
    assert.equal(adoptRemoteParent("invalid", "unused"), undefined);
    assert.equal(adoptRemoteParent(undefined, "unused"), undefined);
    assert.deepEqual(created, [
      { name: "slate.send", traceparent: validParent },
      { name: "slate.gateway.sendMessage", traceparent: validParent },
    ]);
  });

  it("does not trace without a factory and converts factory failures into no trace", () => {
    assert.equal(beginSendTrace(validParent), undefined);
    setHostTraceFactory(() => { throw new Error("trace provider unavailable"); });
    assert.equal(beginSendTrace(validParent), undefined);
    assert.equal(beginGatewayCommandTrace({ traceparent: validParent, method: "ping" }), undefined);
  });

  it("normalizes the sampling ratio while preserving the documented parseFloat form", () => {
    assert.equal(resolveTurnTraceSampleRatio(""), 1);
    assert.equal(resolveTurnTraceSampleRatio("0"), 0);
    assert.equal(resolveTurnTraceSampleRatio("0.4"), 0.4);
    assert.equal(resolveTurnTraceSampleRatio("0.4tail"), 0.4);
    for (const invalid of ["not-a-number", "-0.1", "1.01", "Infinity"]) {
      assert.equal(resolveTurnTraceSampleRatio(invalid), 1, invalid);
    }
  });

  it("classifies turns in automation, request-source, hidden, then user order", () => {
    assert.equal(resolveTurnTraceType({ automationWake: false, requestSource: "notification", hidden: true }), "automation");
    assert.equal(resolveTurnTraceType({ requestSource: "handoff-resume", hidden: true }), "handoff-resume");
    assert.equal(resolveTurnTraceType({ requestSource: "turn", hidden: true }), "hidden");
    assert.equal(resolveTurnTraceType({}), "user");
  });

  it("prefers an existing parent context and stamps root, turn, bundle and caller attributes", () => {
    const parentContext = { owner: "outer" };
    const recorder = spanRecorder({ child: true });
    const optionsSeen: Array<Parameters<TraceFactory>[0]> = [];
    setTurnTraceHostBundleVersion(" build-17 ");
    setHostTraceFactory((options) => { optionsSeen.push(options); return recorder.trace; });

    const result = beginTurnTrace({
      conversationId: "conversation-1",
      turnType: "automation",
      parentCtx: parentContext,
      startTime: 0,
      sampleRatio: 0,
      attributes: { "slate.model": "model-1" },
    });

    assert.equal(result, recorder.trace);
    assert.equal(SLATE_TURN_ROOT_SPAN_NAME, "slate.turn.run");
    assert.deepEqual(optionsSeen, [{
      name: "slate.turn.run",
      startTime: 0,
      inheritableAttributes: { "slate.conversation_id": "conversation-1", "slate.turn_type": "automation" },
      parentCtx: parentContext,
    }]);
    assert.deepEqual(recorder.calls, [
      ["attribute", "slate.conversation_id", "conversation-1"],
      ["attribute", "slate.turn_type", "automation"],
      ["attribute", "slate.host_bundle_version", "build-17"],
      ["attribute", "slate.model", "model-1"],
    ]);
  });

  it("uses a new sampled parent when the supplied context cannot produce a trace", () => {
    const optionsSeen: Array<Parameters<TraceFactory>[0]> = [];
    const recorder = spanRecorder();
    setHostTraceFactory((options) => {
      optionsSeen.push(options);
      return options.parentCtx === undefined ? recorder.trace : undefined;
    });

    assert.equal(beginTurnTrace({ conversationId: "c", turnType: "user", parentCtx: {}, sampleRatio: 1 }), recorder.trace);
    assert.equal(optionsSeen.length, 2);
    assert.deepEqual(optionsSeen[0], {
      name: SLATE_TURN_ROOT_SPAN_NAME,
      inheritableAttributes: { "slate.conversation_id": "c", "slate.turn_type": "user" },
      parentCtx: {},
    });
    assert.equal(optionsSeen[1]?.name, SLATE_TURN_ROOT_SPAN_NAME);
    assert.equal(optionsSeen[1]?.parentCtx, undefined);
    assert.notEqual(parseTraceparent(optionsSeen[1]?.traceparent), undefined);
  });

  it("honors a zero sample ratio and clears whitespace-only bundle versions", () => {
    const seen: unknown[] = [];
    setTurnTraceHostBundleVersion("   ");
    setHostTraceFactory((options) => { seen.push(options); return spanRecorder().trace; });
    assert.equal(beginTurnTrace({ conversationId: "c", turnType: "user", sampleRatio: 0 }), undefined);
    assert.deepEqual(seen, []);
  });

  it("keeps outcome priority and translates unknown errors into span exceptions", () => {
    assert.equal(resolveTurnTraceOutcome({ quiescedForUpgrade: true, aborted: true }), "quiesced_for_upgrade");
    assert.equal(resolveTurnTraceOutcome({ aborted: true, awaitingUserSelection: true }), "aborted");
    assert.equal(resolveTurnTraceOutcome({ awaitingUserSelection: true }), "awaiting_user");
    assert.equal(resolveTurnTraceOutcome({}), "success");

    const recorder = spanRecorder();
    markTurnTraceError(recorder.trace, "disk failure");
    const exception = recorder.calls[0]?.[1] as Error;
    assert.deepEqual([exception.name, exception.message], ["Error", "disk failure"]);
    assert.deepEqual(recorder.calls.slice(1), [
      ["status", { code: 2 }],
      ["attribute", "slate.outcome", "error"],
    ]);
  });

  it("sets optional attributes without requiring a trace", () => {
    const recorder = spanRecorder();
    setTurnTraceAttributes(undefined, { "slate.count": 2 });
    setTurnTraceAttributes(recorder.trace, { "slate.count": 2, "slate.mode": "fast" });
    assert.deepEqual(recorder.calls, [
      ["attribute", "slate.count", 2],
      ["attribute", "slate.mode", "fast"],
    ]);
  });

  it("runs a child span with its parent's context and closes it after success", async () => {
    const parent = spanRecorder({ parent: true });
    const child = spanRecorder({ child: true });
    let factoryOptions: Parameters<TraceFactory>[0] | undefined;
    setHostTraceFactory((options) => { factoryOptions = options; return child.trace; });
    let seenContext: HostTrace | undefined;

    const result = await traceSendPhase(parent.trace, "slate.send.prepare", async (context) => {
      seenContext = context;
      return "ready";
    });
    assert.equal(result, "ready");
    assert.equal(seenContext, child.trace);
    assert.deepEqual(factoryOptions, { name: "slate.send.prepare", parentCtx: parent.trace.context });
    assert.deepEqual(child.calls, [["end"]]);
  });

  it("falls back to the original context when child creation fails or no factory exists", async () => {
    const parent = spanRecorder({ parent: true });
    const seen: Array<HostTrace | undefined> = [];
    setHostTraceFactory(() => { throw new Error("child creation failed"); });
    assert.equal(await traceSendPhase(parent.trace, "child", async (context) => { seen.push(context); return 1; }), 1);
    setHostTraceFactory(undefined as never);
    assert.equal(await traceSendPhase(parent.trace, "child", async (context) => { seen.push(context); return 2; }), 2);
    assert.deepEqual(seen, [parent.trace, parent.trace]);
  });

  it("records child failures, closes the span, and rethrows the original error", async () => {
    const parent = spanRecorder({ parent: true });
    const child = spanRecorder();
    const failure = new Error("send failed");
    setHostTraceFactory(() => child.trace);

    await assert.rejects(
      () => traceSendPhase(parent.trace, "slate.send.transmit", async () => { throw failure; }),
      (error: unknown) => error === failure,
    );
    assert.deepEqual(child.calls, [
      ["exception", failure],
      ["status", { code: 2 }],
      ["end"],
    ]);
  });
});
