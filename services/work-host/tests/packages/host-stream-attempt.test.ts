import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createOuterStreamLifecycle, createStreamAttempt } from "../../source/host/runner/stream-attempt.ts";
import { FirstTokenStallError, type RetryPolicy } from "../../source/host/runner/transient-stream-error.ts";

function fakeHost(options: any = {}) {
  const calls: any[] = [];
  let resolveStream: ((value: unknown) => void) | undefined;
  let rejectStream: ((failure: unknown) => void) | undefined;
  let timerCallback: (() => void) | undefined;
  let disarmHook: (() => void) | undefined;
  let resetHook: (() => void) | undefined;
  let outputProduced = options.outputProduced ?? false;
  const stream = new Promise((resolve, reject) => { resolveStream = resolve; rejectStream = reject; });
  const host: any = {
    ctx: { canceled: options.canceled === true, withCancel: () => [{ attemptContext: true }, (reason: unknown) => calls.push(["cancel", reason])] },
    hidden: options.hidden === true,
    transientStreamRetry: options.retryPolicy,
    setStreamOutputProduced: (value: boolean) => { outputProduced = value; calls.push(["output", value]); },
    getStreamOutputProduced: () => outputProduced,
    persistCheckpoint: async (_ctx: unknown, checkpoint: unknown, accepted: (persisted: unknown) => void) => {
      calls.push(["persist", checkpoint]);
      if (options.persistThrows !== undefined) throw options.persistThrows;
      accepted(checkpoint + "-stored");
    },
    startStream: async (ctx: unknown, resume: unknown, persist: (ctx: unknown, checkpoint: unknown) => Promise<void>) => {
      calls.push(["start", resume, ctx]);
      if (options.onStart) await options.onStart(persist, calls.length);
      if (options.startThrows !== undefined) throw options.startThrows;
      return stream;
    },
    createDeadlineTimer: (callback: () => void, deadlineMs: number) => {
      calls.push(["timer", deadlineMs]);
      timerCallback = callback;
      return { cancel: () => calls.push(["timerCancel"]), restart: () => calls.push(["timerRestart"]) };
    },
    setDeadlineHooks: (disarm: () => void, reset: () => void) => { disarmHook = disarm; resetHook = reset; calls.push(["hooks"]); },
    clearDeadlineHookIf: () => calls.push(["clearHooks"]),
    setTraceAttributes: (attributes: unknown) => calls.push(["trace", attributes]),
    emitRetrying: () => calls.push(["emitRetrying"]),
    reportTurnRetry: (info: unknown) => calls.push(["reportRetry", info]),
  };
  return {
    host, calls, stream,
    resolve: (value: unknown) => resolveStream!(value),
    reject: (failure: unknown) => rejectStream!(failure),
    fireTimer: () => timerCallback!(),
    hooks: () => ({ disarm: disarmHook, reset: resetHook }),
    startCalls: () => calls.filter((call) => call[0] === "start"),
    reports: () => calls.filter((call) => call[0] === "reportRetry").map((call) => call[1]),
  };
}
const retryPolicy = (overrides: Partial<RetryPolicy> = {}): RetryPolicy => ({
  maxAttempts: 2,
  baseDelayMs: 0,
  maxDelayMs: 0,
  isRetryable: () => true,
  sleep: async () => {},
  random: () => 0,
  ...overrides,
});

describe("one streamed attempt", () => {
  it("resolves the stream and stops the deadline", async () => {
    const fake = fakeHost();
    const attempt = createStreamAttempt(fake.host);
    const running = attempt.run();
    fake.resolve("final-state");
    assert.equal(await running, "final-state");
    assert.equal(fake.calls.some((call) => call[0] === "timerCancel"), true);
    assert.deepEqual(fake.startCalls()[0]!.slice(1, 3), [undefined, { attemptContext: true }]);
  });

  it("fails the attempt when the first token stalls", async () => {
    const fake = fakeHost({ retryPolicy: retryPolicy({ maxAttempts: 1 }) });
    const attempt = createStreamAttempt(fake.host);
    const running = attempt.run();
    fake.fireTimer();
    await assert.rejects(running, (failure: unknown) => failure instanceof FirstTokenStallError);
    const cancel = fake.calls.find((call) => call[0] === "cancel");
    assert.deepEqual(cancel![1], { intentional: false, reason: "first-token stall" });
    assert.equal(fake.calls.some((call) => call[0] === "timerCancel" && false), false);
  });

  it("skips the deadline when no first-token deadline is set", async () => {
    const previous = process.env.SLATE_FIRST_TOKEN_STALL_DEADLINE_MS;
    process.env.SLATE_FIRST_TOKEN_STALL_DEADLINE_MS = "0";
    try {
      const fake = fakeHost();
      const attempt = createStreamAttempt(fake.host);
      const running = attempt.run();
      fake.resolve("state-without-deadline");
      assert.equal(await running, "state-without-deadline");
      assert.equal(fake.calls.some((call) => call[0] === "timer"), false);
    } finally {
      if (previous === undefined) delete process.env.SLATE_FIRST_TOKEN_STALL_DEADLINE_MS;
      else process.env.SLATE_FIRST_TOKEN_STALL_DEADLINE_MS = previous;
    }
  });

  it("surfaces a checkpoint failure instead of the stream result", async () => {
    const previous = process.env.SLATE_FIRST_TOKEN_STALL_DEADLINE_MS;
    process.env.SLATE_FIRST_TOKEN_STALL_DEADLINE_MS = "0";
    try {
      const failure = new Error("persist boom");
      const fake = fakeHost({
        persistThrows: failure,
        onStart: async (persist: (ctx: unknown, checkpoint: unknown) => Promise<void>) => {
          await assert.rejects(persist({}, "checkpoint"), (error: unknown) => error === failure);
        },
      });
      const attempt = createStreamAttempt(fake.host);
      const running = attempt.run();
      fake.resolve("state-that-lost-its-checkpoint");
      await assert.rejects(running, (error: unknown) => error === failure);
    } finally {
      if (previous === undefined) delete process.env.SLATE_FIRST_TOKEN_STALL_DEADLINE_MS;
      else process.env.SLATE_FIRST_TOKEN_STALL_DEADLINE_MS = previous;
    }
  });

  it("retries a transient failure with the accepted checkpoint", async () => {
    const previous = process.env.SLATE_FIRST_TOKEN_STALL_DEADLINE_MS;
    process.env.SLATE_FIRST_TOKEN_STALL_DEADLINE_MS = "0";
    try {
      let attempts = 0;
      const transient = new Error("transient stream failure");
      const fake = fakeHost({
        retryPolicy: retryPolicy(),
        onStart: async (persist: (ctx: unknown, checkpoint: unknown) => Promise<void>) => {
          attempts += 1;
          if (attempts === 1) {
            await persist({}, "checkpoint-1");
            fake.host.setStreamOutputProduced(true);
          }
        },
      });
      let fakeResolveLater = () => {};
      const attempt = createStreamAttempt(fake.host);
      const running = attempt.run();
      await new Promise((resolve) => setTimeout(resolve, 10));
      fake.reject(transient);
      await assert.rejects(running);
      const starts = fake.startCalls();
      assert.equal(starts.length, 2);
      assert.equal(starts[1]![1], "checkpoint-1-stored");
    } finally {
      if (previous === undefined) delete process.env.SLATE_FIRST_TOKEN_STALL_DEADLINE_MS;
      else process.env.SLATE_FIRST_TOKEN_STALL_DEADLINE_MS = previous;
    }
  });
  it("reports an exhausted retry budget", async () => {
    const previous = process.env.SLATE_FIRST_TOKEN_STALL_DEADLINE_MS;
    process.env.SLATE_FIRST_TOKEN_STALL_DEADLINE_MS = "0";
    try {
      const transient = new Error("overloaded provider");
      const fake = fakeHost({ retryPolicy: retryPolicy(), startThrows: transient });
      const attempt = createStreamAttempt(fake.host);
      await assert.rejects(attempt.run(), (error: unknown) => error === transient);
      const reports = fake.reports() as Array<{ outcome: string; attempt: number; maxAttempts: number }>;
      assert.deepEqual([reports[0]!.outcome, reports[0]!.attempt, reports[0]!.maxAttempts], ["retried", 1, 2]);
      assert.deepEqual([reports[1]!.outcome, reports[1]!.attempt, reports[1]!.maxAttempts], ["exhausted", 2, 2]);
    } finally {
      if (previous === undefined) delete process.env.SLATE_FIRST_TOKEN_STALL_DEADLINE_MS;
      else process.env.SLATE_FIRST_TOKEN_STALL_DEADLINE_MS = previous;
    }
  });
  it("persists the final state and releases the reminder around the run", async () => {
    const calls: any[] = [];
    const persistence: any = {
      generation: 2,
      runGeneration: () => 2,
      prepareCheckpointForPersistence: (checkpoint: unknown) => calls.push(["prepare", checkpoint]),
      persistStepCheckpoint: async (_context: unknown, checkpoint: unknown) => calls.push(["step", checkpoint]),
      persistFinalState: async (_context: unknown, state: unknown) => calls.push(["final", state]),
      commitDiskPressureReminder: () => calls.push(["commitPressure"]),
      releaseDiskPressureReminder: () => calls.push(["releasePressure"]),
      isAwaitingUserSelection: () => false,
      isQuiescingForUpgrade: () => false,
      markQuiescedForUpgrade: () => calls.push(["quiesced"]),
      cancelRun: (cancellation: unknown) => calls.push(["cancelRun", cancellation]),
    };
    const fake = fakeHost({ retryPolicy: retryPolicy({ maxAttempts: 1 }) });
    const lifecycle = createOuterStreamLifecycle({
      attempt: fake.host,
      persistence,
      cleanup: () => { calls.push(["cleanup"]); },
      onCompleted: (state: unknown) => { calls.push(["completed", state]); },
    });
    const running = lifecycle.run({ lifecycleContext: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.resolve("final-state");
    assert.equal(await running, "final-state");
    assert.deepEqual(calls.map((call) => call[0]), ["completed", "cleanup", "final", "commitPressure", "releasePressure"]);
    await lifecycle.persistFinalState({}, "another-state");
    assert.deepEqual(calls.slice(-2).map((call) => call[0]), ["final", "commitPressure"]);
  });

  it("skips persistence when the generation moved on", async () => {
    const calls: any[] = [];
    const persistence: any = {
      generation: 1,
      runGeneration: () => 2,
      prepareCheckpointForPersistence: () => calls.push(["prepare"]),
      persistStepCheckpoint: async () => calls.push(["step"]),
      persistFinalState: async () => calls.push(["final"]),
      commitDiskPressureReminder: () => calls.push(["commitPressure"]),
      releaseDiskPressureReminder: () => calls.push(["releasePressure"]),
      isAwaitingUserSelection: () => false,
      isQuiescingForUpgrade: () => false,
      markQuiescedForUpgrade: () => calls.push(["quiesced"]),
      cancelRun: () => calls.push(["cancelRun"]),
    };
    const fake = fakeHost({ retryPolicy: retryPolicy({ maxAttempts: 1 }) });
    const lifecycle = createOuterStreamLifecycle({ attempt: fake.host, persistence });
    const running = lifecycle.run({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.resolve("state");
    assert.equal(await running, "state");
    assert.deepEqual(calls.map((call) => call[0]), ["releasePressure"]);
  });
});
