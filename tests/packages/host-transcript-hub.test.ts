import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as hub from "../../source/host/transcript/transcript-hub.ts";
import { RUNNER_UNATTACHED_MESSAGE, realClock } from "../../source/host/transcript/transcript-hub.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("the transcript hub's contracts", () => {
  it("exposes the missing-runner message and the real clock, and nothing else at runtime", () => {
    assert.deepEqual(Object.keys(hub).sort(), ["RUNNER_UNATTACHED_MESSAGE", "realClock"], "the rest of the file is types");
    assert.equal(RUNNER_UNATTACHED_MESSAGE, "Slate agent runner factory is not attached.");
    assert.deepEqual(Object.keys(realClock).sort(), ["now", "schedule"]);
  });

  it("reads the time from the runtime itself", () => {
    assert.equal(realClock.now, Date.now, "the clock's time is the runtime's own function, not a wrapper around it");
    const before = Date.now();
    const now = realClock.now();
    const after = Date.now();
    assert.equal(typeof now, "number");
    assert.equal(now >= before && now <= after, true);
  });

  it("schedules a callback once, after its delay, with no arguments", async () => {
    const calls: unknown[][] = [];
    const disposable = realClock.schedule(5, (...args: unknown[]) => calls.push(args));
    assert.deepEqual(Object.keys(disposable), ["dispose"]);
    assert.equal(typeof disposable.dispose, "function");
    await sleep(40);
    assert.equal(calls.length, 1, "the callback runs once and only once");
    assert.deepEqual(calls[0], [], "the callback is handed nothing");
  });

  it("keeps the delay it was given: the shorter timer fires first", async () => {
    const order: string[] = [];
    realClock.schedule(40, () => order.push("long"));
    realClock.schedule(5, () => order.push("short"));
    await sleep(100);
    assert.deepEqual(order, ["short", "long"]);
  });

  it("cancels a scheduled callback when disposed, and disposing is harmless twice or after it ran", async () => {
    let cancelledCalls = 0;
    const cancelled = realClock.schedule(20, () => {
      cancelledCalls += 1;
    });
    cancelled.dispose();
    cancelled.dispose();
    await sleep(50);
    assert.equal(cancelledCalls, 0, "a cancelled timer never runs");

    let firedCalls = 0;
    const fired = realClock.schedule(1, () => {
      firedCalls += 1;
    });
    await sleep(20);
    assert.equal(firedCalls, 1);
    fired.dispose();
    assert.equal(firedCalls, 1, "disposing after the callback ran changes nothing");
  });
});
