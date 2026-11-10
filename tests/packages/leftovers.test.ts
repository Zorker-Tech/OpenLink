/**
 * The pieces that landed last in a few modules: the store sync's own helpers, the analytics client's
 * held events, the model a request names, and the line the local-exec daemon writes when its own
 * invariant breaks.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ANNOUNCED_EVICTION_BATCH, MAX_ANNOUNCED_EVENT_IDS } from "../../source/packages/agent-store-sync/conflict-notice-claim-state.ts";
import { ensureFinitePositive } from "../../source/packages/agent-store-sync/validation.ts";
import { stripS3EtagQuotes } from "../../source/packages/agent-store-sync/etag.ts";
import { NOOP_RESILIENCE_LISTENER } from "../../source/packages/agent-store-sync/resilience-events.ts";
import { DeferredAnalyticsBuffer } from "../../source/packages/analytics-client/deferred-buffer.ts";
import { getProviderModelName } from "../../source/adapters/interop/chat-inference-proto/model-provider-options.ts";
import { LOCAL_EXEC_DAEMON_INVARIANT_EVENT_NAME, writeLocalExecInvariantRecord } from "../../source/local-exec/invariant-violation-log.ts";

describe("the store sync's own helpers", () => {
  it("bounds what it remembers and evicts in a batch", () => {
    assert.equal(MAX_ANNOUNCED_EVENT_IDS, 65_536);
    assert.equal(ANNOUNCED_EVICTION_BATCH, MAX_ANNOUNCED_EVENT_IDS / 8);
  });

  it("refuses a number a client could not work with", () => {
    assert.equal(ensureFinitePositive({ value: 1, name: "timeout", context: "sync" }), 1);
    assert.throws(() => ensureFinitePositive({ value: 0, name: "timeout", context: "sync" }), RangeError);
    assert.throws(() => ensureFinitePositive({ value: Number.NaN, name: "timeout", context: "sync" }), RangeError);
  });

  it("takes the quotes off an entity tag and nothing else", () => {
    assert.equal(stripS3EtagQuotes('"abc"'), "abc");
    assert.equal(stripS3EtagQuotes("  abc  "), "abc");
    assert.equal(stripS3EtagQuotes(null), "");
    assert.equal(stripS3EtagQuotes(undefined), "");
  });

  it("has a listener that cares about nothing by default", () => {
    assert.equal(typeof NOOP_RESILIENCE_LISTENER.onDiskFull, "function");
    assert.equal(typeof NOOP_RESILIENCE_LISTENER.onSymlinkRefused, "function");
    assert.equal(typeof NOOP_RESILIENCE_LISTENER.onNetworkError, "function");
  });
});

describe("events that are held until they can be sent", () => {
  it("keeps what it was given", () => {
    const buffer = new DeferredAnalyticsBuffer();
    buffer.track("turn_finished", { turns: 1 });
    assert.equal(buffer.getEvents().length, 1);
    assert.equal(buffer.getEvents()[0]?.eventName, "turn_finished");
    buffer.clear();
    assert.equal(buffer.getEvents().length, 0);
  });
});

describe("the model a request names", () => {
  it("reads it from the provider's own options, and only when it says something", () => {
    assert.equal(getProviderModelName({ providerOptions: { slate: { modelName: "a-model" } } }), "a-model");
    assert.equal(getProviderModelName({ providerOptions: { slate: { modelName: "" } } }), "");
    assert.equal(getProviderModelName({}), undefined);
    assert.equal(getProviderModelName({ providerOptions: { slate: { modelName: 7 } } }), undefined);
  });
});

describe("a broken invariant in the local-exec daemon", () => {
  it("is logged as one JSON line under its stable event name", () => {
    assert.equal(LOCAL_EXEC_DAEMON_INVARIANT_EVENT_NAME, "slate.local_exec_daemon.invariant_violation");
    const lines: string[] = [];
    writeLocalExecInvariantRecord({ name: "SlateInvariantViolation" }, (line) => lines.push(line));
    assert.deepEqual(lines, ['{"event":"slate.local_exec_daemon.invariant_violation","name":"SlateInvariantViolation"}\n']);
  });
});
