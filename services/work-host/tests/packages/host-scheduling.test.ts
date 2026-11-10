/**
 * The scheduling vocabulary: what a policy refuses to be built with, how a wait is cancelled, and what each policy does
 * with a clock the test controls.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DeadlineExceededError,
  createDeadlinePolicy,
  createDebouncePolicy,
  createExpiryPolicy,
  createIdleWatchdogPolicy,
  createPollingPolicy,
  createRetryPolicy,
  realClock,
  type Clock,
} from "../../source/host/extensions/scheduling.ts";

/** A clock that only moves when the test moves it: every wait in these cases is deterministic. */
function fakeClock() {
  let nowMs = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const scheduledDelays: number[] = [];
  const clock: Clock = {
    now: () => nowMs,
    monotonicNow: () => nowMs,
    schedule(delayMs, callback) {
      const id = nextId++;
      scheduledDelays.push(delayMs);
      timers.set(id, { at: nowMs + delayMs, callback });
      return { dispose: () => void timers.delete(id) };
    },
  };
  return {
    clock,
    scheduledDelays,
    get pending() {
      return timers.size;
    },
    async advance(ms: number) {
      nowMs += ms;
      // Fire what is due, in time order, and let the promises each firing resolves run before the next one.
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= nowMs).sort((left, right) => left[1].at - right[1].at)[0];
        if (due === undefined) return;
        timers.delete(due[0]);
        due[1].callback();
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    /** Fire everything that is scheduled, whatever its delay (a policy's next wait is scheduled only after a tick). */
    async drain() {
      for (let round = 0; round < 200 && timers.size > 0; round += 1) {
        await this.advance(Math.max(0, ...([...timers.values()].map((timer) => timer.at - nowMs))));
      }
    },
    /**
     * Run a piece of work to its end: fire whatever it schedules as it goes, and stop pumping only when it has settled. A
     * promise the caller still owes work cannot be awaited directly — its next step needs a timer that has not fired yet.
     */
    async settle<T>(work: Promise<T>): Promise<T> {
      type Settled = { done: false } | { done: true; value?: T; error?: unknown };
      let state: Settled = { done: false };
      void work.then(
        (value) => {
          state = { done: true, value };
        },
        (error) => {
          state = { done: true, error };
        },
      );
      for (let round = 0; round < 200; round += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        if (state.done) break;
        if (timers.size > 0) await this.advance(Math.max(0, ...([...timers.values()].map((timer) => timer.at - nowMs))));
      }
      if (!state.done) throw new Error("the work never settled");
      const settled: { done: true; value?: T; error?: unknown } = state;
      if (settled.error !== undefined) throw settled.error;
      return settled.value as T;
    },
  };
}

describe("the real clock", () => {
  it("refuses a delay that is not a delay, and a disposed timer does not fire", () => {
    assert.throws(() => realClock.schedule(-1, () => {}), /finite non-negative/);
    assert.throws(() => realClock.schedule(Number.POSITIVE_INFINITY, () => {}), /finite non-negative/);
    let fired = false;
    const timer = realClock.schedule(5, () => {
      fired = true;
    });
    timer.dispose();
    assert.equal(fired, false);
    assert.equal(typeof realClock.now(), "number");
    assert.equal(typeof realClock.monotonicNow(), "number");
  });
});

describe("building a policy", () => {
  it("refuses a blank name and a delay that is not a finite non-negative number", () => {
    const { clock } = fakeClock();
    for (const build of [
      () => createDebouncePolicy(clock, { name: "  ", delayMs: 1 }),
      () => createDebouncePolicy(clock, { name: "d", delayMs: -1 }),
      () => createIdleWatchdogPolicy(clock, { name: "", idleMs: 1 }),
      () => createIdleWatchdogPolicy(clock, { name: "w", idleMs: Number.NaN }),
      () => createPollingPolicy(clock, { name: "p", intervalMs: -2 }),
      () => createPollingPolicy(clock, { name: "p", intervalMs: 0 }),
      () => createExpiryPolicy(clock, { name: "e", ttlMs: -1 }),
      () => createRetryPolicy(clock, { name: "r", maxAttempts: 0, initialDelayMs: 0, maxDelayMs: 0 }),
      () => createRetryPolicy(clock, { name: "r", maxAttempts: 1, initialDelayMs: 5, maxDelayMs: 1 }),
      () => createRetryPolicy(clock, { name: "r", maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffFactor: 0.5 }),
      () => createDeadlinePolicy(clock, { name: "", timeoutMs: 1 }),
      () => createDeadlinePolicy(clock, { name: "dl", timeoutMs: -1 }),
    ]) {
      assert.throws(build);
    }
  });
});

describe("a debounce", () => {
  it("fires once with the latest arguments, and stops when disposed", async () => {
    const fake = fakeClock();
    const calls: unknown[][] = [];
    const debounced = createDebouncePolicy(fake.clock, { name: "d", delayMs: 10 }).wrap((value: unknown) => calls.push([value]));
    debounced("a");
    await fake.advance(5);
    debounced("b");
    await fake.advance(5);
    assert.deepEqual(calls, [], "a call that keeps being postponed has not fired yet");
    await fake.advance(5);
    assert.deepEqual(calls, [["b"]], "only the latest call fires");
    debounced.dispose();
    debounced("c");
    await fake.advance(20);
    assert.deepEqual(calls, [["b"]]);
    assert.equal(fake.pending, 0);
  });
});

describe("a retry", () => {
  it("doubles its wait per attempt, up to the ceiling", () => {
    const fake = fakeClock();
    const policy = createRetryPolicy(fake.clock, { name: "r", maxAttempts: 5, initialDelayMs: 100, maxDelayMs: 250 });
    for (const attempt of [1, 2, 3, 4]) policy.schedule(attempt).dispose();
    // 100, then 200, then the ceiling holds it at 250.
    assert.deepEqual(fake.scheduledDelays, [100, 200, 250, 250]);
    assert.throws(() => policy.schedule(0), /positive integer/);
    assert.throws(() => policy.schedule(1.5), /positive integer/);
  });

  it("retries while attempts last and the error is worth retrying, then gives up with the last error", async () => {
    const fake = fakeClock();
    const attempts: number[] = [];
    const policy = createRetryPolicy(fake.clock, { name: "r", maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 4 });
    const work = policy.runWithRetry(async (attempt) => {
      attempts.push(attempt);
      throw new Error(`attempt ${attempt}`);
    });
    await assert.rejects(() => fake.settle(work), /attempt 3/);
    assert.deepEqual(attempts, [1, 2, 3]);
    // A retry that succeeded after one failure is not retried again.
    const flaky = createRetryPolicy(fake.clock, { name: "r", maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 4 });
    let calls = 0;
    const succeeded = flaky.runWithRetry(async () => {
      calls += 1;
      if (calls === 1) throw new Error("first");
      return "ok";
    });
    assert.equal(await fake.settle(succeeded), "ok");
    // An error the policy was told not to retry stops immediately.
    const picky = createRetryPolicy(fake.clock, { name: "r", maxAttempts: 9, initialDelayMs: 1, maxDelayMs: 1, shouldRetry: (error) => !(error instanceof RangeError) });
    let pickyCalls = 0;
    const refused = picky.runWithRetry(async () => {
      pickyCalls += 1;
      throw new RangeError("no");
    });
    await assert.rejects(() => fake.settle(refused), RangeError);
    assert.equal(pickyCalls, 1);
  });

  it("stops when the caller cancels, with the caller's reason", async () => {
    const fake = fakeClock();
    const controller = new AbortController();
    const policy = createRetryPolicy(fake.clock, { name: "r", maxAttempts: 5, initialDelayMs: 10, maxDelayMs: 10 });
    const work = policy.runWithRetry(async () => {
      throw new Error("fails");
    }, controller.signal);
    await fake.advance(1);
    controller.abort(new Error("caller changed their mind"));
    await assert.rejects(() => work, /caller changed their mind/);
    assert.equal(fake.pending, 0, "a cancelled retry leaves no timer behind");
  });

  it("stops waiting on work that never finishes when the caller cancels", async () => {
    const fake = fakeClock();
    const controller = new AbortController();
    const policy = createRetryPolicy(fake.clock, { name: "r", maxAttempts: 5, initialDelayMs: 10, maxDelayMs: 10 });
    // The attempt itself never settles: only the cancellation can end the retry.
    const work = policy.runWithRetry(async () => await new Promise<never>(() => {}), controller.signal);
    const settled = work.catch((error: unknown) => error);
    await fake.advance(1);
    controller.abort(new Error("stop now"));
    assert.match(String(await settled), /stop now/);
  });

  it("hands a signal to work that was given none, and never aborts it", async () => {
    const fake = fakeClock();
    const policy = createRetryPolicy(fake.clock, { name: "r", maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 });
    const seen = policy.runWithRetry(async (_attempt, signal) => {
      assert.equal(signal.aborted, false);
      return "done";
    });
    assert.equal(await fake.settle(seen), "done");
  });
});

describe("an idle watchdog", () => {
  it("fires after the idle time, re-arms on a kick, and stops on dispose", async () => {
    const fake = fakeClock();
    const fired: number[] = [];
    const armed = createIdleWatchdogPolicy(fake.clock, { name: "w", idleMs: 10 }).arm(() => fired.push(fake.clock.now()));
    await fake.advance(5);
    armed.kick();
    await fake.advance(5);
    assert.deepEqual(fired, [], "a kicked watchdog starts its count again");
    await fake.advance(10);
    assert.deepEqual(fired, [20]);
    armed.dispose();
    armed.kick();
    await fake.advance(50);
    assert.deepEqual(fired, [20]);
    assert.equal(fake.pending, 0);
  });
});

describe("a poller", () => {
  it("ticks, waits, and ticks again until it is disposed", async () => {
    const fake = fakeClock();
    const ticks: number[] = [];
    const polling = createPollingPolicy(fake.clock, { name: "p", intervalMs: 10 }).start(async () => {
      ticks.push(fake.clock.now());
    });
    await fake.advance(0);
    await fake.advance(10);
    await fake.advance(10);
    assert.deepEqual(ticks, [0, 10, 20]);
    polling.dispose();
    await fake.advance(30);
    assert.deepEqual(ticks, [0, 10, 20]);
    assert.equal(fake.pending, 0);
  });

  it("stops when a tick fails, and never starts for a signal that is already aborted", async () => {
    const fake = fakeClock();
    const ticks: number[] = [];
    const polling = createPollingPolicy(fake.clock, { name: "p", intervalMs: 10 }).start(async () => {
      ticks.push(fake.clock.now());
      if (ticks.length === 2) throw new Error("the tick failed");
    });
    await fake.advance(0);
    await fake.advance(10);
    await fake.advance(10);
    assert.deepEqual(ticks, [0, 10], "a rejected tick ends the poller rather than being retried");
    assert.equal(fake.pending, 0);
    // A tick that throws synchronously is the same story.
    const throwing = createPollingPolicy(fake.clock, { name: "p", intervalMs: 10 }).start(() => {
      throw new Error("synchronously broken");
    });
    await fake.advance(10);
    assert.equal(fake.pending, 0);
    throwing.dispose();
    const controller = new AbortController();
    controller.abort();
    const never = createPollingPolicy(fake.clock, { name: "p", intervalMs: 10 }).start(async () => {
      ticks.push(-1);
    }, controller.signal);
    await fake.advance(30);
    assert.equal(ticks.includes(-1), false);
    never.dispose();
    // A poller cancelled after it started stops as well.
    const cancelling = new AbortController();
    const late = createPollingPolicy(fake.clock, { name: "p", intervalMs: 10 }).start(async () => {
      ticks.push(99);
    }, cancelling.signal);
    await fake.advance(0);
    cancelling.abort();
    await fake.advance(30);
    assert.equal(ticks.filter((tick) => tick === 99).length, 1);
    late.dispose();
  });
});

describe("an expiry", () => {
  it("expires a key once, replaces an older arm, and only lets the current arm dispose the entry", async () => {
    const fake = fakeClock();
    const expired: string[] = [];
    const policy = createExpiryPolicy(fake.clock, { name: "e", ttlMs: 10 });
    const first = policy.arm("a", () => expired.push("first"));
    first.dispose();
    const second = policy.arm("a", () => expired.push("second"));
    await fake.advance(10);
    assert.deepEqual(expired, ["second"]);
    // Disposing an arm that was already replaced does not disturb the current one: the entry still belongs to `fourth`,
    // so arming again replaces it as usual.
    const third = policy.arm("b", () => expired.push("third"));
    const fourth = policy.arm("b", () => expired.push("fourth"));
    third.dispose();
    const fifth = policy.arm("b", () => expired.push("fifth"));
    await fake.advance(10);
    assert.deepEqual(expired, ["second", "fifth"]);
    fifth.dispose();
    fourth.dispose();
    assert.equal(fake.pending, 0);
  });
});

describe("a deadline", () => {
  it("lets work that finishes in time through, and aborts the work's signal when the deadline passes", async () => {
    const fake = fakeClock();
    const policy = createDeadlinePolicy(fake.clock, { name: "turn", timeoutMs: 10 });
    const quick = policy.run(async () => "in time");
    await fake.advance(1);
    assert.equal(await quick, "in time");
    let sawAbort = false;
    const slow = policy.run(async (signal) => {
      signal.addEventListener("abort", () => {
        sawAbort = true;
      });
      // The work never finishes on its own: only the deadline can end it.
      return await new Promise<string>(() => {});
    });
    // The rejection happens while the clock is being advanced, so it is claimed before that turn ends.
    const slowSettled = slow.catch((error: unknown) => error);
    await fake.advance(10);
    const deadlineError = await slowSettled;
    assert.equal(deadlineError instanceof DeadlineExceededError && deadlineError.policyName === "turn" && deadlineError.code === "deadline_exceeded", true);
    assert.equal(sawAbort, true, "the work was told to stop, not just ignored");
    assert.equal(fake.pending, 0);
  });

  it("turns a caller's cancellation into the caller's own reason", async () => {
    const fake = fakeClock();
    const controller = new AbortController();
    const policy = createDeadlinePolicy(fake.clock, { name: "turn", timeoutMs: 50 });
    const work = policy.run(async () => await new Promise<string>(() => {}), controller.signal);
    const settled = work.catch((error: unknown) => error);
    await fake.advance(1);
    controller.abort(new Error("user cancelled"));
    assert.match(String(await settled), /user cancelled/);
    assert.equal(fake.pending, 0);
    // A signal that is already aborted never runs the work at all.
    const already = new AbortController();
    already.abort(new Error("too late"));
    await assert.rejects(() => policy.run(async () => "unreachable", already.signal), /too late/);
  });
});
