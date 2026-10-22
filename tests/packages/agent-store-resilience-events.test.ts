import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NOOP_RESILIENCE_LISTENER,
  safeNotifyListener,
  type ResilienceListener,
} from "../../source/packages/agent-store-sync/resilience-events.ts";

/** A listener that records how it was called. */
function recordingListener(): { listener: ResilienceListener; calls: unknown[] } {
  const calls: unknown[] = [];
  const listener: ResilienceListener = {
    onDiskFull(this: unknown, event: unknown) {
      calls.push({ method: "onDiskFull", thisIsListener: this === listener, event });
      return undefined;
    },
    onSymlinkRefused(this: unknown, event: unknown) {
      calls.push({ method: "onSymlinkRefused", thisIsListener: this === listener, event });
    },
  };
  return { listener, calls };
}

describe("notifying a resilience listener", () => {
  it("calls the one method it was asked about, bound to the listener and handed the event", () => {
    const { listener, calls } = recordingListener();
    const event = { kind: "disk-full" };
    safeNotifyListener(listener, "onDiskFull", event);
    assert.deepEqual(calls, [{ method: "onDiskFull", thisIsListener: true, event }]);
  });

  it("does nothing for a listener that is not there, or that does not have the method", () => {
    const calls: unknown[] = [];
    const notAFunction = { call() { calls.push("called"); } };
    safeNotifyListener(undefined, "onDiskFull", {});
    safeNotifyListener({}, "onDiskFull", {});
    safeNotifyListener({ onDiskFull: 5 as never }, "onDiskFull", {});
    safeNotifyListener({ onDiskFull: null as never }, "onDiskFull", {});
    safeNotifyListener({ onDiskFull: notAFunction as never }, "onDiskFull", {});
    assert.deepEqual(calls, [], "only a function is called");
    safeNotifyListener(NOOP_RESILIENCE_LISTENER, "onNetworkError", {});
  });

  it("swallows a handler that throws", () => {
    const listener: ResilienceListener = { onDiskFull() { throw new Error("listener bug"); } };
    assert.equal(safeNotifyListener(listener, "onDiskFull", {}), undefined);
  });

  it("leaves an answer that is not a promise alone", () => {
    for (const answer of [undefined, null, 0, false, "", "yes", {}, [], { then: "later" }]) {
      const listener: ResilienceListener = { onDiskFull: () => answer };
      assert.equal(safeNotifyListener(listener, "onDiskFull", {}), undefined, String(answer));
    }
  });

  it("lets a promise a listener answered with settle on its own", async () => {
    const settled: string[] = [];
    const listener: ResilienceListener = {
      async onDiskFull() {
        settled.push("handler");
        return "done";
      },
    };
    safeNotifyListener(listener, "onDiskFull", {});
    assert.deepEqual(settled, ["handler"]);
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("attaches quiet handlers to a thenable the listener answered with", () => {
    const seen: unknown[] = [];
    const thenable = {
      then(onFulfilled: () => void, onRejected: (error: unknown) => void) {
        seen.push(["then", typeof onFulfilled, typeof onRejected]);
        onFulfilled();
        onRejected(new Error("ignored"));
        return undefined;
      },
    };
    const listener: ResilienceListener = { onDiskFull: () => thenable };
    safeNotifyListener(listener, "onDiskFull", {});
    assert.deepEqual(seen, [["then", "function", "function"]]);
  });

  it("lets a thenable's own failure out, because only the handler call is guarded", () => {
    const listener: ResilienceListener = {
      onDiskFull() {
        return { then() { throw new Error("then failed"); } };
      },
    };
    assert.throws(() => safeNotifyListener(listener, "onDiskFull", {}), { message: "then failed" });
  });
});

describe("the listener that does nothing", () => {
  it("answers nothing from every event, and cannot be changed", () => {
    assert.equal(Object.isFrozen(NOOP_RESILIENCE_LISTENER), true);
    assert.deepEqual(Object.keys(NOOP_RESILIENCE_LISTENER), ["onDiskFull", "onSymlinkRefused", "onNetworkError"]);
    assert.equal(NOOP_RESILIENCE_LISTENER.onDiskFull({}), undefined);
    assert.equal(NOOP_RESILIENCE_LISTENER.onSymlinkRefused({}), undefined);
    assert.equal(NOOP_RESILIENCE_LISTENER.onNetworkError({}), undefined);
    for (const key of ["onDiskFull", "onSymlinkRefused", "onNetworkError"] as const) {
      assert.equal(Object.getOwnPropertyDescriptor(NOOP_RESILIENCE_LISTENER, key)?.writable, false, key);
    }
  });
});