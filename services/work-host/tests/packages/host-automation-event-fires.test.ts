import { mock, test } from "node:test";
import assert from "node:assert/strict";

import {
  AutomationEventFires,
  EVENT_FIRE_DEBOUNCE_MS,
  MAX_QUEUED_EVENT_FIRES_PER_AUTOMATION,
  MAX_REPORTED_DROPPED_FIRES,
} from "../../source/host/transcript/automation-event-fires.ts";
import { MAX_EVENTS_IN_AUTOMATION_WAKE, type AutomationRecord } from "../../source/host/automations/automation.ts";

const automation = (id = "auto-1", name = "Daily digest") => ({ id, name } as unknown as AutomationRecord);
const event = (index: number) => ({ type: "event", index });

function harness(options: { canExecute?: boolean; disposed?: boolean; fire?: (payload: unknown) => Promise<string> } = {}) {
  const fires: any[] = [];
  const reported: any[] = [];
  const tm = {
    execution: { canExecute: options.canExecute ?? true },
    disposed: options.disposed ?? false,
    automationRuntime: {
      async fireAutomation(payload: any) {
        fires.push(payload);
        return options.fire === undefined ? "ok" : options.fire(payload);
      },
    },
    telemetry: { reportAutomationFireDropped: (dropped: any) => reported.push(dropped) },
  };
  return { service: new AutomationEventFires(tm as never), fires, reported, tm };
}
const batchKeys = (service: AutomationEventFires) => [...service.pendingEventFireBatches.keys()];
async function flushNow(service: AutomationEventFires, key: string) {
  const batch = service.pendingEventFireBatches.get(key);
  if (batch != null) {
    if (batch.timer != null) clearTimeout(batch.timer);
    batch.timer = null;
    batch.debounce = null;
  }
  await service.flushEventBatch(key);
}
const settleAll = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a disabled or disposed host does not queue an event", async () => {
  for (const options of [{ canExecute: false }, { disposed: true }]) {
    const world = harness(options);
    assert.equal(await world.service.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation(), event: event(1) }), undefined);
    assert.equal(world.service.pendingEventFireBatches.size, 0);
    assert.equal(world.fires.length, 0);
  }
});

test("events for one automation are gathered and fired together", async () => {
  const world = harness();
  const first = world.service.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation(), event: event(1), runUuid: "run-1" });
  const second = world.service.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation(), event: event(2), runUuid: "run-2" });
  const third = world.service.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation(), event: event(3) });
  const key = batchKeys(world.service)[0]!;
  assert.equal(typeof key, "string");
  assert.equal(world.service.pendingEventFireBatches.get(key)?.items.length, 3);
  await flushNow(world.service, key);
  assert.equal(world.fires.length, 1);
  const fired = world.fires[0];
  assert.equal(fired.agentId, "agent-1");
  assert.equal(fired.trigger, "event");
  assert.deepEqual(fired.events, [event(1), event(2), event(3)]);
  assert.equal(fired.runUuid, "run-1");
  assert.deepEqual(fired.coalescedRunUuids, ["run-2"]);
  assert.deepEqual([await first, await second, await third], ["ok", "ok", "ok"]);
  assert.equal(world.service.pendingEventFireBatches.size, 0);
});

test("different agents and automations have their own batches", async () => {
  const world = harness();
  const a = world.service.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation("a"), event: event(1) });
  const b = world.service.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation("b"), event: event(2) });
  const c = world.service.enqueueEventAutomationFire({ agentId: "agent-2", automation: automation("a"), event: event(3) });
  assert.equal(world.service.pendingEventFireBatches.size, 3);
  for (const key of batchKeys(world.service)) await flushNow(world.service, key);
  assert.equal(world.fires.length, 3);
  await Promise.all([a, b, c]);
});

test("an automation is fired with a fire-and-forget timer", async () => {
  const world = harness();
  const pending = world.service.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation(), event: event(1) });
  const key = batchKeys(world.service)[0]!;
  // The timer is armed for the debounce window and the caller is still waiting.
  assert.notEqual(world.service.pendingEventFireBatches.get(key)?.timer, null);
  assert.equal(world.fires.length, 0);
  assert.equal(EVENT_FIRE_DEBOUNCE_MS, 750);
  const batch = world.service.pendingEventFireBatches.get(key);
  if (batch?.timer != null) clearTimeout(batch.timer);
  batch!.timer = null;
  batch!.debounce = null;
  await world.service.flushEventBatch(key);
  assert.equal(await pending, "ok");
});

test("an overflowing queue drops its oldest events and reports them", async () => {
  const world = harness();
  const promises = [];
  for (let index = 0; index < MAX_QUEUED_EVENT_FIRES_PER_AUTOMATION + 1; index += 1) {
    promises.push(world.service.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation(), event: event(index), runUuid: "run-" + index }));
  }
  const key = batchKeys(world.service)[0]!;
  assert.equal(world.service.pendingEventFireBatches.get(key)?.items.length, MAX_QUEUED_EVENT_FIRES_PER_AUTOMATION);
  assert.equal(world.reported.length, 1);
  assert.deepEqual({ ...world.reported[0], latenessMs: undefined }, { conversationId: "agent-1", trigger: "event", reason: "event_batch_overflow", latenessMs: undefined });
  assert.equal(world.service.reportedDroppedFireUuids.has("run-0"), true);
  assert.equal(await promises[0], "error");
  // Draining the batch fires everything that was kept.
  const kept: unknown[] = [];
  while (world.service.pendingEventFireBatches.has(key)) {
    await flushNow(world.service, key);
    kept.push(...(world.fires.at(-1)?.events ?? []));
  }
  assert.equal(kept.length, MAX_QUEUED_EVENT_FIRES_PER_AUTOMATION);
  await Promise.all(promises.slice(1));
});

test("a batch larger than one wake is fired in more than one wake", async () => {
  const world = harness();
  const total = MAX_EVENTS_IN_AUTOMATION_WAKE + 1;
  for (let index = 0; index < total; index += 1) world.service.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation(), event: event(index) });
  const key = batchKeys(world.service)[0]!;
  await flushNow(world.service, key);
  assert.equal(world.fires.length, 1);
  assert.equal(world.fires[0].events.length, MAX_EVENTS_IN_AUTOMATION_WAKE);
  while (world.service.pendingEventFireBatches.has(key)) await flushNow(world.service, key);
  assert.equal(world.fires.length >= 2, true);
  assert.equal(world.fires.every((fire) => fire.events.length <= MAX_EVENTS_IN_AUTOMATION_WAKE), true);
  assert.equal(world.fires.flatMap((fire) => fire.events).length, total);
});

test("a fire that throws is logged and resolves its callers without an outcome", async () => {
  const originalError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    const world = harness({ fire: async () => { throw new Error("dispatch broke"); } });
    const pending = world.service.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation(), event: event(1) });
    const key = batchKeys(world.service)[0]!;
    await flushNow(world.service, key);
    assert.equal(await pending, undefined);
    assert.equal(logged.length, 1);
    assert.equal(String(logged[0]?.[0]).includes("event wake dispatch failed"), true);
    assert.equal(world.service.pendingEventFireBatches.size, 0);
  } finally {
    console.error = originalError;
  }
});

test("a dropped fire is reported once per run", async () => {
  const world = harness();
  const dropped = { agentId: "agent-1", trigger: "schedule", reason: "late", runUuid: "run-1" } as const;
  world.service.reportFireDropped({ ...dropped });
  world.service.reportFireDropped({ ...dropped });
  assert.equal(world.reported.length, 1);
  assert.equal(world.reported[0].conversationId, "agent-1");
  assert.equal(world.service.reportedDroppedFireUuids.size, 1);
});

test("the reported run ids are bounded, dropping the oldest first", async () => {
  const world = harness();
  for (let index = 0; index < MAX_REPORTED_DROPPED_FIRES + 1; index += 1) {
    world.service.reportFireDropped({ agentId: "agent-1", trigger: "manual", reason: "late", runUuid: "run-" + index });
  }
  assert.equal(world.service.reportedDroppedFireUuids.size, MAX_REPORTED_DROPPED_FIRES);
  assert.equal(world.service.reportedDroppedFireUuids.has("run-0"), false);
  world.service.reportFireDropped({ agentId: "agent-1", trigger: "manual", reason: "late", runUuid: "run-0" });
  assert.equal(world.reported.length, MAX_REPORTED_DROPPED_FIRES + 2);
});

test("a scheduled drop carries its lateness, an unscheduled one does not", async () => {
  const world = harness();
  world.service.reportFireDropped({ agentId: "agent-1", trigger: "schedule", reason: "late", scheduledForMs: Date.now() - 1000 });
  world.service.reportFireDropped({ agentId: "agent-1", trigger: "manual", reason: "overflow" });
  assert.equal(world.reported[0].scheduledForMs <= Date.now(), true);
  assert.equal(world.reported[0].latenessMs >= 900, true);
  assert.equal("scheduledForMs" in world.reported[1], false);
  assert.equal("latenessMs" in world.reported[1], false);
});

test("the latest automation record is the one fired", async () => {
  const world = harness();
  const first = world.service.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation("auto-1", "Old name"), event: event(1) });
  const second = world.service.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation("auto-1", "New name"), event: event(2) });
  const key = batchKeys(world.service)[0]!;
  await flushNow(world.service, key);
  assert.equal(world.fires[0].automation.name, "New name");
  await Promise.all([first, second]);
  await settleAll();
});
test("the exported caps and the debounce window are the protocol", () => {
  assert.equal(EVENT_FIRE_DEBOUNCE_MS, 750);
  assert.equal(MAX_QUEUED_EVENT_FIRES_PER_AUTOMATION, 500);
  assert.equal(MAX_REPORTED_DROPPED_FIRES, 256);
})

test("the debounce is armed once and fires after its window", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const world = harness();
    world.service.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation(), event: event(1) });
    mock.timers.tick(500);
    world.service.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation(), event: event(2) });
    mock.timers.tick(250);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(world.fires.length, 1);
    assert.deepEqual(world.fires[0].events, [event(1), event(2)]);
  } finally {
    mock.timers.reset();
  }
});

test("an aborted debounce does not fire", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const world = harness();
    world.service.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation(), event: event(1) });
    const key = batchKeys(world.service)[0]!;
    world.service.pendingEventFireBatches.get(key)?.debounce?.abort();
    mock.timers.tick(EVENT_FIRE_DEBOUNCE_MS);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(world.fires.length, 0);
    await flushNow(world.service, key);
    assert.equal(world.fires.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("leftover events after a wake are flushed immediately", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const world = harness();
    const total = MAX_EVENTS_IN_AUTOMATION_WAKE + 1;
    for (let index = 0; index < total; index += 1) world.service.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation(), event: event(index) });
    const key = batchKeys(world.service)[0]!;
    await flushNow(world.service, key);
    assert.equal(world.fires.length, 1);
    mock.timers.tick(0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(world.fires.length, 2);
    assert.equal(world.service.pendingEventFireBatches.size, 0);
  } finally {
    mock.timers.reset();
  }
});
