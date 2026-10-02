/**
 * The automations a conversation has: what the runtime watches, what it writes down when they change, what it publishes
 * to the interface, and what it hands to the machinery that runs them.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { AutomationRuntime } from "../../source/host/transcript/automation-runtime.ts";
import { runAgentStoreWorker } from "../../source/host/agents/isolation/agent-store-worker.ts";
import { REPLY_NUDGE_PROMPT } from "../../source/host/transcript/turn-runtime.ts";
import { AUTOMATION_PROMPT_GUIDANCE_VERSION } from "../../source/host/automations/automation.ts";
import { stableAutomationId } from "../../source/host/automations/automation-id.ts";

type Call = { name: string; args: unknown[] };

/** An automation as a conversation keeps one, with just enough for the runtime to describe it. */
function automationOf(overrides: Record<string, unknown> = {}) {
  return {
    id: "auto-1",
    name: "Morning report",
    prompt: "Write it.",
    trigger: { type: "cron", schedule: "0 9 * * *" },
    schedule: "0 9 * * *",
    isEnabled: true,
    createdAt: 1_000,
    runs: [],
    ...overrides,
  } as never;
}

/** A conversation's own automation store, with the change listener the runtime wires up. */
function fakeAutomations(initial: ReturnType<typeof automationOf>[] = []) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  let definitions = [...initial];
  let onChange: (() => void) | undefined;
  return {
    calls,
    named: (name: string) => calls.filter((call) => call.name === name),
    setOnChange(listener?: () => void) {
      onChange = listener;
      record("setOnChange", listener !== undefined);
    },
    fireOnChange() {
      onChange?.();
    },
    listDefinitions: () => definitions,
    list: () => definitions,
    get: (id: string) => definitions.find((automation) => (automation as { id: string }).id === id) ?? null,
    setEnabled: (id: string, isEnabled: boolean) => {
      definitions = definitions.map((automation) => ((automation as { id: string }).id === id ? automationOf({ ...(automation as object), id, isEnabled }) : automation));
      record("setEnabled", id, isEnabled);
    },
    upsert: (spec: unknown) => {
      definitions = [...definitions, automationOf({ id: "created-1", ...(spec as object) })];
      record("upsert");
    },
    update: (id: string, spec: unknown) => {
      definitions = definitions.map((automation) => ((automation as { id: string }).id === id ? automationOf({ ...(automation as object), ...(spec as object), id }) : automation));
      record("update", id);
    },
    remove: (id: string) => {
      definitions = definitions.filter((automation) => (automation as { id: string }).id !== id);
      record("remove", id);
    },
  };
}

/** A transcript manager with the store, the emitter and the reporting an automation runtime reaches for. */
function world(
  options: {
    automations?: ReturnType<typeof fakeAutomations>;
    activeSession?: unknown;
    shouldEmit?: boolean;
    storedAutomations?: Array<Record<string, unknown>>;
    storeResult?: Array<Record<string, unknown>>;
    storeError?: Error;
    timeZone?: string;
  } = {},
) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const automations = options.automations ?? fakeAutomations();
  const activeSessionOption = options.activeSession === undefined ? undefined : options.activeSession;
  const session = activeSessionOption === undefined ? undefined : (activeSessionOption as { id: string });
  const storeAutomations = options.storedAutomations ?? [];
  const emitter = new EventEmitter();
  const tm = {
    sessions: { activeSession: session },
    sessionStore: {
      getUserTimeZone: () => options.timeZone,
      listAgentAutomations: (agentId: string) => {
        record("listAgentAutomations", agentId);
        return storeAutomations;
      },
      listAllAutomations: async () => {
        record("listAllAutomations");
        return storeAutomations;
      },
      listAllAutomationDefinitions: async () => {
        record("listAllAutomationDefinitions");
        return storeAutomations;
      },
      setAgentAutomationEnabled: (agentId: string, automationId: string, isEnabled: boolean) => {
        record("storeSetEnabled", automationId, isEnabled);
        if (options.storeError !== undefined) throw options.storeError;
        return options.storeResult ?? storeAutomations;
      },
      createAgentAutomation: (agentId: string, spec: unknown) => {
        record("storeCreate");
        if (options.storeError !== undefined) throw options.storeError;
        return storeAutomations;
      },
      updateAgentAutomation: (agentId: string, automationId: string, spec: unknown) => {
        record("storeUpdate", automationId);
        if (options.storeError !== undefined) throw options.storeError;
        return storeAutomations;
      },
      removeAgentAutomation: (agentId: string, automationId: string) => {
        record("storeRemove", automationId);
        if (options.storeError !== undefined) throw options.storeError;
        return storeAutomations;
      },
    },
    telemetry: { reportAutomationLifecycle: (report: unknown) => record("reportAutomationLifecycle", report) },
    productAnalytics: { trackEvent: (name: string, properties: unknown) => record("trackEvent", name, properties) },
    emitTimelineEvent: (agentId: string, event: unknown) => record("emitTimelineEvent", agentId, event),
    roster: { emitter },
    shouldEmitAutomations: () => options.shouldEmit !== false,
    automationConfigChanged: () => record("automationConfigChanged"),
  };
  const runtime = new AutomationRuntime(tm as never);
  return {
    runtime, tm, automations, session, emitter, calls,
    named: (name: string) => calls.filter((call) => call.name === name),
    lifecycles: () => calls.filter((call) => call.name === "reportAutomationLifecycle").map((call) => call.args[0] as Record<string, unknown>),
    analytics: () => calls.filter((call) => call.name === "trackEvent").map((call) => call.args[1] as Record<string, unknown>),
  };
}

const activeWorld = (automations = fakeAutomations()) =>
  world({ automations, activeSession: { id: "agent-1", automations } });

describe("watching a conversation's automations", () => {
  it("shares what it owns with the machinery underneath", () => {
    const world1 = world();
    assert.equal(world1.runtime.runPath.spendGuard, world1.runtime.spendGuard);
    assert.equal(world1.runtime.pendingEventFireBatches, world1.runtime.eventFires.pendingEventFireBatches);
    // And tells whoever asked when the configuration changed, tolerating nobody having asked.
    world1.runtime.notifyAutomationConfigChanged();
    assert.equal(world1.named("automationConfigChanged").length, 1);
  });

  it("watches a conversation's store once, and writes down what the store reports", async () => {
    const automations = fakeAutomations([automationOf()]);
    const world1 = world({ automations, activeSession: { id: "agent-1", automations } });
    world1.runtime.watchSessionAutomations(world1.tm.sessions.activeSession);
    assert.deepEqual(world1.automations.named("setOnChange").map((call) => call.args), [[true]]);
    assert.equal(world1.runtime.watchedAutomations, automations);
    // Watching the same store again does not wire a second listener or re-seed.
    world1.runtime.watchSessionAutomations(world1.tm.sessions.activeSession);
    assert.equal(world1.automations.named("setOnChange").length, 1);
    assert.equal(world1.runtime.lastKnownAutomations.get("agent-1")?.size, 1);
    // A change the store reports is followed by writing down what changed, publishing, and saying the configuration
    // moved — all through the per-agent chain.
    const published: unknown[] = [];
    const unsubscribe = world1.runtime.subscribeAutomations((value) => published.push(value));
    automations.upsert({ name: "Second", prompt: "p", trigger: { type: "cron", schedule: "0 8 * * *" } });
    world1.automations.fireOnChange();
    await new Promise((resolve) => setImmediate(resolve));
    unsubscribe();
    // What the store now holds was published to the interface as well.
    assert.deepEqual(published.map((value) => (value as { agentId: string }).agentId), ["agent-1"]);
    assert.equal(world1.lifecycles().length, 1);
    assert.deepEqual([world1.lifecycles()[0]?.action, world1.lifecycles()[0]?.source], ["created", "agent"]);
    assert.equal(world1.named("automationConfigChanged").length >= 1, true);
    // Watching a different store lets the old one go.
    const other = fakeAutomations();
    world1.runtime.watchSessionAutomations({ id: "agent-2", automations: other });
    assert.deepEqual(world1.automations.named("setOnChange").at(-1)?.args, [false]);
  });

  it("seeds what it knows about an agent once", () => {
    const world1 = activeWorld();
    world1.runtime.seedKnownAutomations(world1.tm.sessions.activeSession);
    const seeded = world1.runtime.lastKnownAutomations.get("agent-1");
    assert.equal(seeded?.size, 0);
    world1.runtime.seedKnownAutomations(world1.tm.sessions.activeSession);
    assert.equal(world1.runtime.lastKnownAutomations.get("agent-1"), seeded);
  });
});

describe("what a change is written down as", () => {
  it("notices a created, updated, enabled, disabled and deleted automation, and nothing else", () => {
    const automations = fakeAutomations([automationOf({ id: "one", name: "One" })]);
    const world1 = world({ automations, activeSession: { id: "agent-1", automations } });
    // The first look is not a change: it is what was already there.
    world1.runtime.recordAutomationChangeEvents(world1.tm.sessions.activeSession, "agent");
    assert.deepEqual(world1.lifecycles(), []);
    // A conversation that is not the one on screen is not written down here, however often it is looked at.
    world1.runtime.recordAutomationChangeEvents({ id: "agent-2", automations }, "agent");
    automations.update("one", { name: "Renamed elsewhere" });
    world1.runtime.recordAutomationChangeEvents({ id: "agent-2", automations }, "agent");
    assert.deepEqual(world1.lifecycles(), []);
    automations.update("one", { name: "One" });
    // A change that nothing about the automation explains is not a change at all.
    world1.runtime.recordAutomationChangeEvents(world1.tm.sessions.activeSession, "agent");
    assert.deepEqual(world1.lifecycles(), []);
    // Then the real ones.
    const changes: Array<[string, () => void]> = [
      ["updated", () => automations.update("one", { name: "One renamed" })],
      ["disabled", () => automations.setEnabled("one", false)],
      ["enabled", () => automations.setEnabled("one", true)],
      ["created", () => automations.upsert({ id: "two", name: "Two", prompt: "p", trigger: { type: "cron", schedule: "0 8 * * *" } })],
      ["deleted", () => automations.remove("one")],
    ];
    for (const [action, change] of changes) {
      change();
      world1.runtime.recordAutomationChangeEvents(world1.tm.sessions.activeSession, "automations_ui");
      assert.deepEqual([world1.lifecycles().at(-1)?.action, world1.lifecycles().at(-1)?.source], [action, "automations_ui"]);
    }
    // Every change was also a timeline event.
    const events = world1.named("emitTimelineEvent").map((call) => call.args[1] as Record<string, unknown>);
    assert.deepEqual(events.map((event) => [event.type, event.action]), [
      ["automation-changed", "updated"],
      ["automation-changed", "disabled"],
      ["automation-changed", "enabled"],
      ["automation-changed", "created"],
      ["automation-changed", "deleted"],
    ]);
    assert.deepEqual(events[0]?.automationId, "one");
    assert.equal(typeof events[0]?.automationName, "string");
  });

  it("says what an automation is, how old it is and how it fires", () => {
    const automations = fakeAutomations([automationOf({ id: "one", name: "One", schedule: "@every 1h", trigger: { type: "cron", schedule: "@every 1h" }, createdAt: Date.now() - 5_000 })]);
    const world1 = world({ automations, activeSession: { id: "agent-1", automations } });
    world1.runtime.recordAutomationChangeEvents(world1.tm.sessions.activeSession, "agent");
    automations.update("one", { name: "One renamed" });
    world1.runtime.recordAutomationChangeEvents(world1.tm.sessions.activeSession, "agent");
    const report = world1.lifecycles()[0] ?? {};
    assert.deepEqual([report.conversationId, report.action, report.source, report.triggerType, report.automationId], ["agent-1", "updated", "agent", "cron", stableAutomationId({ agentId: "agent-1", localId: "one" })]);
    assert.equal(report.ageMs !== undefined && (report.ageMs as number) >= 5_000, true);
    assert.equal(report.recordedRunCount, 0);
    // An automation that has runs reports how many it has recorded.
    const withRuns = fakeAutomations([automationOf({ id: "one", name: "One", runs: [{ id: "a" }, { id: "b" }] })]);
    const runWorld = world({ automations: withRuns, activeSession: { id: "agent-1", automations: withRuns } });
    runWorld.runtime.recordAutomationChangeEvents(runWorld.tm.sessions.activeSession, "agent");
    withRuns.update("one", { name: "Renamed" });
    runWorld.runtime.recordAutomationChangeEvents(runWorld.tm.sessions.activeSession, "agent");
    assert.equal(runWorld.lifecycles()[0]?.recordedRunCount, 2);
    // An hourly schedule fires every hour for the next week, and some of those hours are overnight.
    assert.equal(report.scheduledFiresNext7Days, 168);
    assert.deepEqual([report.firesOnWeekend, report.firesOvernight], [true, true]);
    const analytics = world1.analytics()[0] ?? {};
    assert.deepEqual([analytics.agent_id, analytics.action, analytics.guidance_version], ["agent-1", "updated", AUTOMATION_PROMPT_GUIDANCE_VERSION]);
    assert.equal(analytics.scheduled_fires_next_7_days, report.scheduledFiresNext7Days);
    // An automation that is not a schedule has nothing to say about when it fires.
    const eventDriven = fakeAutomations([automationOf({ id: "three", trigger: { type: "slack", channel: "C1", match: { kind: "mention" } }, schedule: "" })]);
    const eventWorld = world({ automations: eventDriven, activeSession: { id: "agent-1", automations: eventDriven } });
    eventWorld.runtime.recordAutomationChangeEvents(eventWorld.tm.sessions.activeSession, "agent");
    eventDriven.update("three", { name: "Renamed" });
    eventWorld.runtime.recordAutomationChangeEvents(eventWorld.tm.sessions.activeSession, "agent");
    assert.deepEqual([eventWorld.lifecycles()[0]?.triggerType, "scheduledFiresNext7Days" in (eventWorld.lifecycles()[0] ?? {})], ["slack", false]);
    assert.equal("scheduled_fires_next_7_days" in (eventWorld.analytics()[0] ?? {}), false);
  });

  it("writes down a change made to a conversation that is not on screen, from what the store holds", () => {
    const world1 = world({ activeSession: { id: "agent-2", automations: fakeAutomations() }, storedAutomations: [automationOf({ id: "one", name: "One" })] as never });
    // With nothing known yet, what the store held is taken as the starting point, so nothing is a change.
    world1.runtime.recordInactiveAutomationChanges({ agentId: "agent-1", before: world1.tm.sessionStore.listAgentAutomations("agent-1") as never, after: world1.tm.sessionStore.listAgentAutomations("agent-1") as never, source: "agent" });
    assert.deepEqual(world1.lifecycles(), []);
    // A change from that starting point is written down for the conversation it belongs to.
    world1.runtime.recordInactiveAutomationChanges({ agentId: "agent-1", before: [automationOf({ id: "one", name: "One" })] as never, after: [automationOf({ id: "one", name: "One renamed" })] as never, source: "automations_ui" });
    assert.deepEqual([world1.lifecycles().at(-1)?.conversationId, world1.lifecycles().at(-1)?.action, world1.lifecycles().at(-1)?.source], ["agent-1", "updated", "automations_ui"]);
    // Nothing is put on a timeline: that conversation's timeline is not the one on screen.
    assert.deepEqual(world1.named("emitTimelineEvent"), []);
  });
});

describe("the chain a conversation's changes run on", () => {
  it("runs one change at a time on a conversation, and never leaves the chain broken", async () => {
    const world1 = world();
    const order: string[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = world1.runtime.enqueueAutomationLifecycleMutation({
      agentId: "agent-1",
      mutation: async () => {
        order.push("first:start");
        await held;
        order.push("first:end");
      },
    });
    const second = world1.runtime.enqueueAutomationLifecycleMutation({ agentId: "agent-1", mutation: () => void order.push("second") });
    const other = world1.runtime.enqueueAutomationLifecycleMutation({ agentId: "agent-2", mutation: () => void order.push("other") });
    await other;
    // Another conversation is not held up by this one.
    assert.deepEqual(order, ["first:start", "other"]);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first:start", "other", "first:end", "second"]);
    // A change that failed does not stop the one behind it, and the chain is forgotten once it settles.
    const failing = world();
    await assert.rejects(() =>
      failing.runtime.enqueueAutomationLifecycleMutation({
        agentId: "agent-1",
        mutation: () => {
          throw new Error("the mutation failed");
        },
      }),
    );
    assert.deepEqual(await failing.runtime.enqueueAutomationLifecycleMutation({ agentId: "agent-1", mutation: () => "done" }), "done");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failing.runtime.automationLifecycleMutationChains.size, 0);
  });

  it("makes a change against the conversation on screen differently from one that is not", async () => {
    const automations = fakeAutomations([automationOf({ id: "one" })]);
    const world1 = world({ automations, activeSession: { id: "agent-1", automations }, storedAutomations: [automationOf({ id: "one", name: "Stored" })] as never });
    // On screen: the change is made on the session's own store, and both sides of it are written down.
    const published: unknown[] = [];
    const unsubscribe = world1.runtime.subscribeAutomations((value) => published.push(value));
    await world1.runtime.setAgentAutomationEnabled("agent-1", "one", false);
    unsubscribe();
    assert.deepEqual(automations.named("setEnabled").map((call) => call.args), [["one", false]]);
    // A change made through the runtime publishes what it produced.
    assert.deepEqual(published.map((value) => (value as { agentId: string }).agentId), ["agent-1"]);
    assert.deepEqual((published[0] as { automations: Array<{ isEnabled: boolean }> }).automations.map((entry) => entry.isEnabled), [false]);
    assert.equal(world1.named("storeSetEnabled").length, 0);
    assert.deepEqual(world1.lifecycles().map((lifecycle) => [lifecycle.recordedRunCount, lifecycle.action]), [[0, "disabled"]]);
    // Not on screen: the change goes through the store, and the pair of readings around it is written down.
    const elsewhere = world({
      activeSession: { id: "agent-2", automations: fakeAutomations() },
      storedAutomations: [automationOf({ id: "one", name: "Stored", isEnabled: false })] as never,
      storeResult: [automationOf({ id: "one", name: "Stored", isEnabled: true })] as never,
    });
    await elsewhere.runtime.setAgentAutomationEnabled("agent-1", "one", true);
    assert.equal(elsewhere.named("storeSetEnabled").length, 1);
    // The pair of readings around the store's change is what is written down: it was switched on.
    assert.deepEqual(elsewhere.lifecycles().map((lifecycle) => [lifecycle.action, lifecycle.source, lifecycle.conversationId]), [["enabled", "automations_ui", "agent-1"]]);
    // Whatever the change, the configuration is said to have moved — even when the store refused it.
    const failing = world({ activeSession: { id: "agent-2", automations: fakeAutomations() }, storeError: new Error("the store refused") });
    await assert.rejects(() => failing.runtime.createAgentAutomation("agent-1", { name: "n", prompt: "p", trigger: { type: "cron", schedule: "0 9 * * *" } } as never));
    assert.equal(failing.named("automationConfigChanged").length, 1);
  });
});

describe("what the interface is shown", () => {
  it("shows the interface no more automations than it can show", async () => {
    const many = fakeAutomations(Array.from({ length: 120 }, (_, index) => automationOf({ id: `auto-${index}`, name: `Automation ${index}` })));
    const world1 = world({ automations: many, activeSession: { id: "agent-1", automations: many } });
    const seen: Array<{ automations: unknown[] }> = [];
    world1.runtime.subscribeAutomations((value) => seen.push(value as { automations: unknown[] }));
    world1.runtime.emitAutomations(world1.tm.sessions.activeSession);
    assert.deepEqual(seen[0]?.automations.length, 100);
    assert.deepEqual((await world1.runtime.getAgentAutomations("agent-1")).length, 100);
  });

  it("publishes the automations of the conversation on screen, and nothing when it should not", () => {
    const automations = fakeAutomations([automationOf()]);
    const world1 = world({ automations, activeSession: { id: "agent-1", automations } });
    const seen: unknown[] = [];
    const unsubscribe = world1.runtime.subscribeAutomations((value) => seen.push(value));
    world1.runtime.emitAutomations(world1.tm.sessions.activeSession);
    assert.deepEqual(seen, [{ agentId: "agent-1", automations: automations.list() }]);
    unsubscribe();
    world1.runtime.emitAutomations(world1.tm.sessions.activeSession);
    assert.equal(seen.length, 1);
    // A conversation that is not on screen is not published, and neither is anything when the platform says not to.
    world1.runtime.emitAutomations({ id: "agent-2", automations });
    const quiet = world({ automations, activeSession: { id: "agent-1", automations }, shouldEmit: false });
    const quietSeen: unknown[] = [];
    quiet.runtime.subscribeAutomations((value) => quietSeen.push(value));
    quiet.runtime.emitAutomations(quiet.tm.sessions.activeSession);
    quiet.runtime.publishAutomations("agent-1", ["one"]);
    assert.deepEqual(quietSeen, []);
    // Publishing directly is gated the same way.
    world1.runtime.publishAutomations("agent-1", ["one"]);
    assert.deepEqual(seen.length, 1);
    assert.deepEqual(seen.at(-1), { agentId: "agent-1", automations: automations.list() });
  });

  it("answers for the conversation on screen from its own store and for the rest from the store", async () => {
    const automations = fakeAutomations([automationOf()]);
    const world1 = world({ automations, activeSession: { id: "agent-1", automations }, storedAutomations: [automationOf({ id: "stored" })] as never });
    assert.deepEqual(await world1.runtime.getAgentAutomations("agent-1"), automations.list());
    assert.deepEqual((await world1.runtime.getAgentAutomations("agent-2")).map((entry) => (entry as { id: string }).id), ["stored"]);
    assert.deepEqual((await world1.runtime.listAllAutomations()).map((entry) => (entry as { id: string }).id), ["stored"]);
    assert.deepEqual((await world1.runtime.listAllAutomationDefinitions()).map((entry) => (entry as { id: string }).id), ["stored"]);
  });
});

describe("what is asked of an automation", () => {
  it("runs one now from wherever it is, and does nothing for one that is not there", async () => {
    const automations = fakeAutomations([automationOf()]);
    const world1 = activeWorld(automations);
    // A conversation with nothing to run does not fire anything.
    await world1.runtime.runAgentAutomationNow("agent-1", "nobody");
    assert.equal(world1.named("runPathFire").length, 0);
    const fired: unknown[] = [];
    world1.runtime.runPath.fireAutomation = async (args: unknown) => {
      fired.push(args);
      return "ok";
    };
    await world1.runtime.runAgentAutomationNow("agent-1", "auto-1");
    assert.deepEqual((fired[0] as { trigger: string; agentId: string }).trigger, "manual");
    // Off screen the automation is looked up in the store.
    const elsewhere = world({ activeSession: { id: "agent-2", automations: fakeAutomations() }, storedAutomations: [automationOf({ id: "auto-1" })] as never });
    const offscreenFired: unknown[] = [];
    elsewhere.runtime.runPath.fireAutomation = async (args: unknown) => {
      offscreenFired.push(args);
      return "ok";
    };
    await elsewhere.runtime.runAgentAutomationNow("agent-1", "auto-1");
    assert.equal(offscreenFired.length, 1);
    await elsewhere.runtime.runAgentAutomationNow("agent-1", "nobody");
    assert.equal(offscreenFired.length, 1);
  });

  it("hands the scheduled, event and guard work to the machinery that owns each", async () => {
    const world1 = world();
    const fired: Array<Record<string, unknown>> = [];
    world1.runtime.runPath.fireAutomation = async (args: unknown) => {
      fired.push(args as Record<string, unknown>);
      return "interrupted";
    };
    assert.equal(await world1.runtime.runServerScheduledAutomation({ agentId: "agent-1", automation: automationOf(), runUuid: "run-1", scheduledForMs: 5_000 }), "interrupted");
    assert.deepEqual([fired[0]?.trigger, fired[0]?.runUuid, fired[0]?.scheduledForMs], ["schedule", "run-1", 5_000]);
    // Without a moment to be late for, none is claimed.
    await world1.runtime.runServerScheduledAutomation({ agentId: "agent-1", automation: automationOf(), runUuid: "run-2" });
    assert.equal("scheduledForMs" in (fired[1] ?? {}), false);
    const eventFired: unknown[] = [];
    world1.runtime.eventFires.enqueueEventAutomationFire = async (args: unknown) => {
      eventFired.push(args);
      return "ok";
    };
    await world1.runtime.runAutomationForEvent("agent-1", automationOf(), { kind: "message" });
    await world1.runtime.runServerAutomationForEvent({ agentId: "agent-1", automation: automationOf(), event: { kind: "message" }, runUuid: "run-3" });
    assert.equal(eventFired.length, 2);
    const answered: unknown[] = [];
    world1.runtime.spendGuard.handleWidgetAnswer = async (args: unknown) => {
      answered.push(args);
      return "applied";
    };
    assert.equal(await world1.runtime.handleSpendGuardWidgetAnswer({ value: "spend-guard:keep" }), "applied");
    assert.equal(answered.length, 1);
  });

  it("asks again when a hidden turn delivered nothing, and says whether it did", async () => {
    const world1 = world();
    const runs: Array<[string, unknown]> = [];
    const runner = {
      run: async (prompt: string, options: unknown) => {
        runs.push([prompt, options]);
        return { sentMessageCount: 1, reacted: false, aborted: false };
      },
    };
    assert.equal(await world1.runtime.ensureHiddenTurnReply(runner), true);
    assert.deepEqual([runs[0]?.[0], (runs[0]?.[1] as { hidden: boolean }).hidden], [REPLY_NUDGE_PROMPT, true]);
    // A reply that reached nobody, and one that was aborted, are both answered as not delivered.
    assert.equal(await world1.runtime.ensureHiddenTurnReply({ run: async () => ({ sentMessageCount: 0, reacted: false, aborted: false }) }), false);
    assert.equal(await world1.runtime.ensureHiddenTurnReply({ run: async () => ({ sentMessageCount: 1, reacted: false, aborted: true }) }), false);
  });
});
