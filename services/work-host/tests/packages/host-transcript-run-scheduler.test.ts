import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SlateRunScheduler, takeNextUserTask } from "../../source/host/transcript/run-scheduler.ts";

function makeClock() {
  let time = 0;
  const timers: Array<{ delay: number; fire: () => void; disposed: boolean }> = [];
  return {
    timers,
    now: () => time,
    advance: (ms: number) => { time += ms; },
    schedule: (delay: number, fire: () => void) => {
      const timer = { delay, fire, disposed: false };
      timers.push(timer);
      return { dispose: () => { timer.disposed = true; } };
    },
  };
}
function harness(options: any = {}) {
  const clock = makeClock();
  const events: any[] = [];
  const starts: string[] = [];
  const scheduler = new SlateRunScheduler({
    watchdogMs: options.watchdogMs ?? 1_000,
    watchdogGraceMs: options.watchdogGraceMs ?? 500,
    interruptWedgedRun: (agentId: string) => { events.push(["interrupt", agentId]); return true; },
    telemetry: {
      onAccepted: (event: any) => events.push(["accepted", event]),
      onDequeued: (event: any) => events.push(["dequeued", event]),
      onWatchdog: (event: any) => events.push(["watchdog", event]),
    },
    onRunStart: (agentId: string) => starts.push(agentId),
  } as never, clock as never);
  return { scheduler, clock, events, starts };
}
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); };

describe("scheduling transcript runs", () => {
  it("picks an ordinary user task before a group member", () => {
    assert.equal(takeNextUserTask([]), undefined);
    assert.deepEqual(takeNextUserTask([{ source: "group-member" }, { source: "user" }, { source: "group-member" }]), { source: "user" });
    assert.deepEqual(takeNextUserTask([{ source: "group-member" }, { source: "group-member" }]), { source: "group-member" });
  });

  it("accepts a task, reports it and runs it", async () => {
    const { scheduler, events, starts } = harness();
    try {
      const done = scheduler.enqueue("agent-1", async () => undefined, { lane: "user", source: "user" });
      await done;
      await flush();
      const accepted = events.find((event) => event[0] === "accepted")!;
      assert.deepEqual(accepted[1], { agentId: "agent-1", lane: "user", source: "user", position: 0, depthUser: 1, depthAgent: 0, depthBackground: 0, hasActive: false });
      assert.deepEqual(starts, ["agent-1"]);
      assert.deepEqual(events.filter((event) => event[0] === "dequeued")[0]![1].queueWaitMs >= 0, true);
    } finally { scheduler.dispose(); }
  });

  it("runs one task at a time, in lane order", async () => {
    const { scheduler, events } = harness();
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const enqueue = (name: string, lane: string) => scheduler.enqueue("agent-1", async () => {
      order.push(name);
      await new Promise<void>((resolve) => releases.push(resolve));
    }, { lane: lane as never, source: lane });
    const promises = [enqueue("b1", "background"), enqueue("a1", "agent"), enqueue("u1", "user")];
    await flush();
    assert.deepEqual(order, ["u1"], "only the user task runs while it holds the slot");
    for (let round = 0; round < 20 && releases.length > 0; round += 1) { while (releases.length > 0) releases.shift()!(); await flush(); }
    await Promise.allSettled(promises);
    assert.deepEqual(order, ["u1", "a1", "b1"]);
    assert.equal(events.filter((event) => event[0] === "dequeued").length, 3);
    scheduler.dispose();
  });

  it("counts the position behind an active run and the agent lane", async () => {
    const { scheduler, events } = harness();
    const release: Array<() => void> = [];
    const first = scheduler.enqueue("agent-1", async () => { await new Promise<void>((resolve) => release.push(resolve)); }, { lane: "user", source: "user" });
    await flush();
    const agent = scheduler.enqueue("agent-1", async () => undefined, { lane: "agent", source: "agent" });
    const user = scheduler.enqueue("agent-1", async () => undefined, { lane: "user", source: "user" });
    const accepted = events.filter((event) => event[0] === "accepted").map((event) => event[1].position);
    assert.deepEqual(accepted, [0, 1, 1], "the user position counts only what waits for the user lane");
    while (release.length > 0) release.shift()!();
    await flush();
    await Promise.allSettled([first, agent, user]);
    scheduler.dispose();
  });

  it("reports diagnostics and the active lane", async () => {
    const { scheduler, clock } = harness();
    const releases: Array<() => void> = [];
    const held = scheduler.enqueue("agent-1", async () => { await new Promise<void>((resolve) => releases.push(resolve)); }, { lane: "user", source: "user" });
    const waiting = scheduler.enqueue("agent-1", async () => undefined, { lane: "agent", source: "agent", acceptedAtMs: 0 });
    await flush();
    clock.advance(250);
    const rows = scheduler.getDiagnostics();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.depthTotal, 2);
    assert.equal((rows[0]!.active as any).lane, "user");
    assert.equal(scheduler.getActiveLane("agent-1"), "user");
    assert.equal(scheduler.getActiveLane("nobody"), undefined);
    while (releases.length > 0) releases.shift()!();
    await flush();
    await held; await waiting;
    scheduler.dispose();
    assert.deepEqual(scheduler.getDiagnostics(), [], "an idle queue is not reported");
  });

  it("does not run a task once disposed", async () => {
    const { scheduler, starts } = harness();
    scheduler.dispose();
    const queued = scheduler.enqueue("agent-1", async () => undefined, { lane: "user", source: "user" });
    await flush();
    assert.deepEqual(starts, [], "a disposed scheduler does not start work");
    void queued;
  });

  it("drains a queue, including tasks still waiting", async () => {
    const { scheduler } = harness();
    const first = scheduler.enqueue("agent-1", async () => { await new Promise((resolve) => setTimeout(resolve, 2)); }, { lane: "user", source: "user" });
    const second = scheduler.enqueue("agent-1", async () => undefined, { lane: "agent", source: "agent" });
    await scheduler.drain("agent-1");
    await Promise.allSettled([first, second]);
    await scheduler.drain("never-seen");
    scheduler.dispose();
  });

  it("trips the watchdog when a user task waits too long, and escapes it", async () => {
    const { scheduler, clock, events } = harness({ watchdogMs: 100, watchdogGraceMs: 50 });
    const held = scheduler.enqueue("agent-1", async () => { await new Promise<void>(() => undefined); }, { lane: "user", source: "user", ackToken: "ack-1" });
    const waiting = scheduler.enqueue("agent-1", async () => undefined, { lane: "user", source: "user" });
    const releases: Array<() => void> = [];
    void held.catch(() => undefined);
    await flush();
    assert.equal(clock.timers.length, 1, "a watchdog is armed while a user task waits");
    clock.timers[0]!.fire();
    await flush();
    assert.equal(events.some((event) => event[0] === "watchdog" && event[1].stage === "trip"), false, "an early tick only re-arms the watchdog");
    clock.advance(200);
    clock.timers[1]!.fire();
    await flush();
    const trip = events.find((event) => event[0] === "watchdog" && event[1].stage === "trip")!;
    assert.deepEqual([trip[1].activeLane, trip[1].waitingUserAgeMs >= 0, trip[1].interrupted], ["user", true, true]);
    assert.equal((scheduler.getDiagnostics()[0]?.active as any)?.phase, "interrupted", "the wedged run is marked interrupted");
    const grace = clock.timers.find((timer) => timer.delay === 50)!;
    grace.fire();
    await flush();
    const escape = events.find((event) => event[0] === "watchdog" && event[1].stage === "escape")!;
    assert.deepEqual([escape[1].activeLane, escape[1].ackToken], ["user", "ack-1"]);
    await Promise.race([held.then(() => "resolved"), new Promise((resolve) => setTimeout(() => resolve("still-wedged"), 50))]).then((outcome) => assert.equal(outcome, "resolved", "the escaped run is answered"));
    await waiting;
    void releases;
    scheduler.dispose();
  });
});