import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as bufferModule from "../../source/packages/analytics-client/deferred-buffer.ts";
import { DeferredAnalyticsBuffer } from "../../source/packages/analytics-client/deferred-buffer.ts";

describe("the deferred analytics buffer", () => {
  it("holds tracked events in the order they happened, with every field written", () => {
    const buffer = new DeferredAnalyticsBuffer();
    assert.deepEqual(buffer.getEvents(), []);
    buffer.track("event.one", { plan: "free" }, 123);
    buffer.track("event.two");
    assert.deepEqual(buffer.getEvents(), [
      { eventName: "event.one", props: { plan: "free" }, timestamp: 123 },
      { eventName: "event.two", props: undefined, timestamp: undefined },
    ]);
    // The fields are written even when they are undefined, so the event's own keys are always the same three.
    assert.deepEqual(Object.keys(buffer.getEvents()[1] as object), ["eventName", "props", "timestamp"]);
    assert.deepEqual(Object.keys(buffer), ["events"]);
  });

  it("hands back the live list, and keeps the properties object by reference", () => {
    const buffer = new DeferredAnalyticsBuffer();
    const handedOut = buffer.getEvents();
    assert.equal(buffer.getEvents(), handedOut, "the same array is handed back every time");
    buffer.track("event.props", { value: "first" });
    assert.equal(handedOut.length, 1, "an array obtained earlier sees what is tracked later");
    const props = { value: "first" };
    buffer.track("event.reference", props);
    props.value = "changed";
    assert.deepEqual(buffer.getEvents()[1]?.props, { value: "changed" }, "the properties are stored by reference, not copied");
  });

  it("settles a flush without sending, dropping or changing anything", async () => {
    const buffer = new DeferredAnalyticsBuffer();
    buffer.track("event.one", { a: 1 }, 5);
    const pending = buffer.flush(10);
    assert.equal(pending instanceof Promise, true);
    assert.equal(await pending, undefined);
    assert.equal(await buffer.flush(undefined as unknown as number), undefined);
    assert.deepEqual(buffer.getEvents(), [{ eventName: "event.one", props: { a: 1 }, timestamp: 5 }]);
  });

  it("clears by giving the buffer a new list: an old list keeps the events it was handed", () => {
    const buffer = new DeferredAnalyticsBuffer();
    buffer.track("event.one");
    buffer.track("event.two");
    const handedOut = buffer.getEvents();
    assert.equal(buffer.clear(), undefined);
    assert.deepEqual(buffer.getEvents(), []);
    assert.deepEqual(handedOut, [{ eventName: "event.one", props: undefined, timestamp: undefined }, { eventName: "event.two", props: undefined, timestamp: undefined }], "the old list is not emptied, the buffer simply stops using it");
    buffer.track("event.after-clear", undefined, 0);
    assert.deepEqual(buffer.getEvents(), [{ eventName: "event.after-clear", props: undefined, timestamp: 0 }]);
  });

  it("is a class with the four calls the deferred client uses", () => {
    assert.deepEqual(Object.keys(bufferModule).sort(), ["DeferredAnalyticsBuffer"]);
    assert.deepEqual(Object.getOwnPropertyNames(DeferredAnalyticsBuffer.prototype).sort(), ["clear", "constructor", "flush", "getEvents", "track"]);
    assert.equal(new DeferredAnalyticsBuffer().constructor.name, "DeferredAnalyticsBuffer");
  });
});
