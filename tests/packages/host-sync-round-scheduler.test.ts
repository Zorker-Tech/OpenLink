import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SyncRoundScheduler,
  SyncRoundStoodAsideError,
  isSyncRoundStoodAsideError,
} from "../../source/packages/agent-store-sync/sync-round-scheduler.ts";

/** A promise a test finishes by hand, and a way to see that it finished. */
function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}

/** Lets every queued microtask and one timer run, so a round that could have started has. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 1));

type Log = string[];

/** Enqueues a round that records when it starts and waits for its gate, and records how its caller's promise settled. */
function round(
  scheduler: SyncRoundScheduler<string>,
  log: Log,
  kind: "full" | "path",
  name: string,
  options: { readonly signalInto?: (signal: AbortSignal | undefined) => void } = {},
): { readonly promise: Promise<string>; readonly release: () => void; readonly fail: () => void } {
  const started = gate();
  const finish = gate();
  let outcome: "resolve" | "reject" = "resolve";
  const promise = scheduler.enqueue(kind, async (signal) => {
    log.push(`start ${name}`);
    options.signalInto?.(signal);
    started.open();
    await finish.promise;
    if (outcome === "reject") throw new Error(`${name} failed`);
    return `${name} done`;
  });
  promise.then(
    (value) => log.push(`resolved ${name}: ${value}`),
    (error: unknown) => log.push(`rejected ${name}: ${(error as Error).message}`),
  );
  return {
    promise,
    release: () => {
      outcome = "resolve";
      finish.open();
    },
    fail: () => {
      outcome = "reject";
      finish.open();
    },
  };
}

describe("taking one round at a time", () => {
  it("runs a round only after the one before it finished", async () => {
    const log: Log = [];
    const scheduler = new SyncRoundScheduler<string>();
    const first = round(scheduler, log, "full", "a");
    const second = round(scheduler, log, "full", "b");
    await settle();
    assert.deepEqual(log, ["start a"], "the second round waits");
    first.release();
    await settle();
    // The next round starts in the step that settles the previous one, so it starts before the previous caller's
    // continuation runs: a round's caller never sees its result before the round behind it has begun.
    assert.deepEqual(log, ["start a", "start b", "resolved a: a done"]);
    second.release();
    await settle();
    assert.deepEqual(log.slice(-1), ["resolved b: b done"]);
  });

  it("lets a failed round fail on its own and still runs the next one", async () => {
    const log: Log = [];
    const scheduler = new SyncRoundScheduler<string>();
    const first = round(scheduler, log, "full", "a");
    const second = round(scheduler, log, "full", "b");
    await settle();
    first.fail();
    await settle();
    await assert.rejects(first.promise, /a failed/);
    assert.deepEqual(log.slice(0, 3), ["start a", "start b", "rejected a: a failed"]);
    second.release();
    await settle();
    assert.equal(await second.promise, "b done");
  });

  it("hands a full round the signal that says it should stand aside, and a path round none", async () => {
    const log: Log = [];
    const scheduler = new SyncRoundScheduler<string>();
    const signals: Array<AbortSignal | undefined> = [];
    const full = round(scheduler, log, "full", "a", { signalInto: (signal) => signals.push(signal) });
    await settle();
    full.release();
    await settle();
    const path = round(scheduler, log, "path", "p", { signalInto: (signal) => signals.push(signal) });
    await settle();
    path.release();
    await settle();
    assert.equal(signals.length, 2);
    assert.equal(signals[0] instanceof AbortSignal, true);
    assert.equal(signals[1], undefined);
  });
});

describe("what arrives while the pump is finishing", () => {
  it("keeps waiting full rounds in the order they were asked for", async () => {
    const log: Log = [];
    const scheduler = new SyncRoundScheduler<string>();
    const running = round(scheduler, log, "full", "a");
    await settle();
    const first = round(scheduler, log, "full", "b");
    const second = round(scheduler, log, "full", "c");
    running.release();
    await settle();
    assert.deepEqual(log.filter((line) => line.startsWith("start")), ["start a", "start b"]);
    first.release();
    await settle();
    assert.deepEqual(log.filter((line) => line.startsWith("start")), ["start a", "start b", "start c"]);
    second.release();
    await settle();
  });

  it("runs a round asked for from the round before it, and drains it too", async () => {
    const log: Log = [];
    const scheduler = new SyncRoundScheduler<string>();
    const first = round(scheduler, log, "full", "a");
    let late: ReturnType<typeof round> | undefined;
    // The round asked for here arrives after the first one settled but before the pump has finished: the pump has to
    // pick it up rather than leave it queued with nothing running.
    void first.promise.then(() => {
      late = round(scheduler, log, "path", "b");
    });
    let drained = false;
    const drainedPromise = scheduler.drain().then(() => {
      drained = true;
    });
    first.release();
    await settle();
    assert.deepEqual(log.filter((line) => line.startsWith("start")), ["start a", "start b"]);
    assert.equal(drained, false, "the round that arrived late is still being waited for");
    late?.release();
    await settle();
    assert.equal(drained, true);
    await drainedPromise;
  });
});

describe("a path round and a full round", () => {
  it("puts a path round in front of a full round that is still waiting", async () => {
    const log: Log = [];
    const scheduler = new SyncRoundScheduler<string>();
    const running = round(scheduler, log, "full", "a");
    await settle();
    const waiting = round(scheduler, log, "full", "b");
    const ahead = round(scheduler, log, "path", "p");
    running.release();
    await settle();
    assert.deepEqual(log.filter((line) => line.startsWith("start")), ["start a", "start p"]);
    ahead.release();
    await settle();
    assert.deepEqual(log.filter((line) => line.startsWith("start")), ["start a", "start p", "start b"]);
    waiting.release();
    await settle();
    assert.deepEqual(log.filter((line) => line.startsWith("resolved")), ["resolved a: a done", "resolved p: p done", "resolved b: b done"]);
  });

  it("keeps path rounds in the order they were asked for when no full round is waiting", async () => {
    const log: Log = [];
    const scheduler = new SyncRoundScheduler<string>();
    const first = round(scheduler, log, "path", "a");
    await settle();
    const second = round(scheduler, log, "path", "b");
    first.release();
    await settle();
    assert.deepEqual(log.filter((line) => line.startsWith("start")), ["start a", "start b"]);
    second.release();
    await settle();
  });

  it("stops a full round that is already running, and says why", async () => {
    const log: Log = [];
    const scheduler = new SyncRoundScheduler<string>();
    let reason: unknown;
    const full = round(scheduler, log, "full", "a", {
      signalInto: (signal) => signal?.addEventListener("abort", () => {
        reason = signal.reason;
      }),
    });
    await settle();
    const path = round(scheduler, log, "path", "p");
    assert.equal(isSyncRoundStoodAsideError(reason), true);
    assert.equal((reason as Error).message, "Agent store full sync stood aside for path sync");
    // The full round still settles its own caller: it is stopped, not failed.
    full.release();
    await settle();
    assert.equal(await full.promise, "a done");
    path.release();
    await settle();
  });

  it("aborts nothing when no full round is running", async () => {
    const log: Log = [];
    const scheduler = new SyncRoundScheduler<string>();
    let aborted = false;
    const path = round(scheduler, log, "path", "a", {
      signalInto: (signal) => signal?.addEventListener("abort", () => {
        aborted = true;
      }),
    });
    await settle();
    const other = round(scheduler, log, "path", "b");
    assert.equal(aborted, false);
    path.release();
    other.release();
    await settle();
  });
});

describe("a full round that is no longer running", () => {
  it("is not stopped by a path round that arrives after it finished", async () => {
    const log: Log = [];
    const scheduler = new SyncRoundScheduler<string>();
    let aborted = 0;
    const full = round(scheduler, log, "full", "a", {
      signalInto: (signal) => signal?.addEventListener("abort", () => {
        aborted += 1;
      }),
    });
    await settle();
    full.release();
    await settle();
    const path = round(scheduler, log, "path", "p");
    await settle();
    assert.equal(aborted, 0, "a round that already finished has nothing to stand aside from");
    path.release();
    await settle();
  });
});

describe("a round a watchdog gives up on", () => {
  it("refuses the rounds that had not started with the watchdog's reason", async () => {
    const log: Log = [];
    const scheduler = new SyncRoundScheduler<string>();
    const wedge = round(scheduler, log, "full", "a");
    await settle();
    const waiting = round(scheduler, log, "full", "b");
    const alsoWaiting = round(scheduler, log, "path", "p");
    scheduler.abandonInFlight();
    await settle();
    await assert.rejects(waiting.promise, /Agent store sync round abandoned by watchdog/);
    await assert.rejects(alsoWaiting.promise, /Agent store sync round abandoned by watchdog/);
    wedge.release();
    await settle();
  });

  it("lets the wedged round settle its own caller afterwards, and starts a new round meanwhile", async () => {
    const log: Log = [];
    const scheduler = new SyncRoundScheduler<string>();
    const wedge = round(scheduler, log, "full", "a");
    await settle();
    scheduler.abandonInFlight();
    await settle();
    // A round asked for after the abandon runs even though the wedged body is still out there.
    const fresh = round(scheduler, log, "path", "c");
    await settle();
    assert.deepEqual(log.filter((line) => line.startsWith("start")), ["start a", "start c"]);
    fresh.release();
    await settle();
    assert.equal(await fresh.promise, "c done");
    wedge.release();
    await settle();
    assert.equal(await wedge.promise, "a done", "the body that was abandoned still settles its caller");
  });

  it("stops stopping the abandoned round: a later path round does not touch it again", async () => {
    const log: Log = [];
    const scheduler = new SyncRoundScheduler<string>();
    let aborted = 0;
    const wedge = round(scheduler, log, "full", "a", {
      signalInto: (signal) => signal?.addEventListener("abort", () => {
        aborted += 1;
      }),
    });
    await settle();
    scheduler.abandonInFlight();
    // Asked for in the same step as the abandon: the scheduler no longer holds a stand-aside handle, so this round
    // does not stop a round the watchdog already gave up on.
    const fresh = round(scheduler, log, "path", "c");
    await settle();
    assert.equal(aborted, 0);
    fresh.release();
    wedge.release();
    await settle();
  });

  it("leaves nothing to drain once the abandoned round has finished", async () => {
    const log: Log = [];
    const scheduler = new SyncRoundScheduler<string>();
    const wedge = round(scheduler, log, "full", "a");
    await settle();
    scheduler.abandonInFlight();
    let drained = false;
    const drainedPromise = scheduler.drain().then(() => {
      drained = true;
    });
    await settle();
    assert.equal(drained, true, "an abandoned round is not waited for");
    wedge.release();
    await settle();
    await drainedPromise;
  });
});

describe("draining", () => {
  it("answers at once when nothing was asked for", async () => {
    await new SyncRoundScheduler().drain();
  });

  it("waits for the round that is running and the ones behind it", async () => {
    const log: Log = [];
    const scheduler = new SyncRoundScheduler<string>();
    const first = round(scheduler, log, "full", "a");
    const second = round(scheduler, log, "path", "p");
    let drained = false;
    const drainedPromise = scheduler.drain().then(() => {
      drained = true;
    });
    await settle();
    assert.equal(drained, false);
    first.release();
    await settle();
    assert.equal(drained, false);
    second.release();
    await settle();
    assert.equal(drained, true);
    await drainedPromise;
  });
});

describe("the error a full round stands aside with", () => {
  it("is recognised by its own guard, and nothing else is", () => {
    assert.equal(isSyncRoundStoodAsideError(new SyncRoundStoodAsideError()), true);
    for (const other of [new Error("nope"), null, undefined, "SyncRoundStoodAsideError"]) assert.equal(isSyncRoundStoodAsideError(other), false);
  });
});
