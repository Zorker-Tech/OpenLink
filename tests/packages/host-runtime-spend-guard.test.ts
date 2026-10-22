/**
 * Asking the user before their routines keep spending, and doing what the answer said: the card they are given, what is
 * paused for them, and what their answer changes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AutomationSpendGuardRuntime, CLEARED_GUARD_STATE, disableEveryEnabledRoutine, reEnableGuardPausedRoutines, SPEND_GUARD_ANSWER_OUTCOMES } from "../../source/host/transcript/automation-spend-guard-runtime.ts";
import { buildSpendGuardNudgeWidget, buildSpendGuardPausedWidget, SPEND_GUARD_ANSWER_VALUES, SPEND_GUARD_MIN_UNREAD_COUNT, SPEND_GUARD_PAUSE_DELAY_MS, SPEND_GUARD_SNOOZE_MS } from "../../source/host/transcript/slate-automation-spend-guard.ts";

/** A conversation with routines, a transcript and the guard's own state, as the runtime uses one. */
function conversation(options: { automations?: Array<{ id: string; name: string; isEnabled: boolean; runs: Array<{ startedAt: number }> }>; unread?: { lastViewedAt: number; unreadCount: number }; state?: Partial<{ nudgedAtMs: number | null; snoozedUntilMs: number | null; optedOut: boolean; cardEntryIds: string[]; pausedAutomationIds: string[] }>; entries?: unknown[]; id?: string } = {}) {
  const calls: unknown[][] = [];
  const definitions = options.automations ?? [
    { id: "routine-1", name: "One", isEnabled: true, runs: [] },
    { id: "routine-2", name: "Two", isEnabled: false, runs: [] },
  ];
  let state = { ...CLEARED_GUARD_STATE, ...(options.state ?? {}) };
  const entries = options.entries ?? [];
  const automations = {
    listDefinitions: () => definitions,
    get: (id: string) => definitions.find((automation) => automation.id === id) ?? null,
    setEnabled: (id: string, isEnabled: boolean) => { calls.push(["set-enabled", id, isEnabled]); const found = definitions.find((automation) => automation.id === id); if (found != null) found.isEnabled = isEnabled; },
  };
  const session = {
    id: options.id ?? "agent-1",
    automations,
    db: {
      getUnreadState: () => ({ lastViewedAt: 0, unreadCount: 0, isManuallyUnread: false, ...(options.unread ?? {}) }),
      getAutomationSpendGuardState: () => state,
      setAutomationSpendGuardState: (next: typeof state) => { state = next; calls.push(["guard-state", next]); },
      getTranscriptEntries: () => entries,
      appendTranscriptEntry: (entry: unknown) => { calls.push(["append-db", entry]); entries.push(entry); return true; },
      close: () => {},
    },
  };
  return { session, definitions, automations, calls, entries, state: () => state, kinds: (of: string) => calls.filter((call) => call[0] === of) };
}

/** The host around the runtime: what it is told to record and what it is asked to emit. */
function harness(options: Parameters<typeof conversation>[0] = {}) {
  const trays: Array<{ title: string; detail: string; dedupeKey?: string }> = [];
  const conversationUnderTest = conversation(options);
  const calls = conversationUnderTest.calls;
  const manager = {
    sessionStore: { getUserTimeZone: () => "UTC", markSessionActivity: () => { calls.push(["mark-activity"]); } },
    sessions: { activeSession: undefined as unknown, isAgentGone: (agentId: string) => agentId === "gone", resolveBackgroundSession: async (agentId: string) => { if (agentId === "missing") throw new Error("no session"); return conversationUnderTest.session; } },
    appendEntry: (entry: unknown) => { calls.push(["append-active", entry]); },
    roster: { emitAgentUpdate: async (agentId: string) => { calls.push(["roster", agentId]); } },
    trayErrors: { pushError: (value: { title: string; detail: string; dedupeKey?: string }) => { trays.push(value); } },
    automationConfigChanged: () => { calls.push(["config-changed"]); },
  };
  const host = {
    enqueueAutomationLifecycleMutation: async (args: { agentId: string; mutation: () => void }) => { calls.push(["mutation", args.agentId]); return args.mutation(); },
    recordAutomationChangeEvents: (_session: unknown, source: string) => { calls.push(["change-events", source]); },
    recordInactiveAutomationChanges: (args: { source: string }) => { calls.push(["inactive-changes", args.source]); },
    emitAutomations: () => { calls.push(["emit-automations"]); },
  };
  const runtime = new AutomationSpendGuardRuntime(manager as never, host);
  return { runtime, manager, host, ...conversationUnderTest, trays, kindsOf: (of: string) => calls.filter((call) => call[0] === of) };
}

const away = (over: Record<string, unknown> = {}) => ({ unread: { lastViewedAt: 0, unreadCount: SPEND_GUARD_MIN_UNREAD_COUNT }, ...over });

describe("the guard over what a conversation's routines spend", () => {
  it("knows what each answer does to the routines", () => {
    assert.deepEqual(SPEND_GUARD_ANSWER_OUTCOMES.keep, { routines: "resume-guard-paused", snoozes: true, retiresGuard: false });
    assert.deepEqual(SPEND_GUARD_ANSWER_OUTCOMES.optOut, { routines: "resume-guard-paused", snoozes: false, retiresGuard: true });
    assert.deepEqual(SPEND_GUARD_ANSWER_OUTCOMES.pause, { routines: "disable-every-enabled", snoozes: false, retiresGuard: false });
    assert.deepEqual(SPEND_GUARD_ANSWER_OUTCOMES.stayPaused, { routines: "leave-as-is", snoozes: false, retiresGuard: false });
    assert.deepEqual(CLEARED_GUARD_STATE, { nudgedAtMs: null, snoozedUntilMs: null, optedOut: false, cardEntryIds: [], pausedAutomationIds: [] });
  });

  it("turns every enabled routine off, and only the ones it paused back on", () => {
    const { automations, definitions, calls } = conversation();
    assert.deepEqual(disableEveryEnabledRoutine({ automations } as never), ["routine-1"]);
    assert.deepEqual(definitions.map((automation) => automation.isEnabled), [false, false]);
    assert.deepEqual(calls.map((call) => [call[0], call[1], call[2]]), [["set-enabled", "routine-1", false]]);
    // What it resumes is exactly what it is told to — the routines the guard itself paused.
    reEnableGuardPausedRoutines({ automations } as never, ["routine-1"]);
    assert.deepEqual(definitions.map((automation) => automation.isEnabled), [true, false]);
  });

  it("leaves a conversation alone while the user is here, and nudge them once they are not", async () => {
    // A user who has been around recently is not asked anything.
    const here = harness();
    assert.deepEqual(await here.runtime.apply(here.session, { id: "routine-1" }), { paused: false });
    assert.deepEqual(here.kinds("append-db"), []);
    assert.deepEqual(here.kinds("tray"), []);

    // Away for a while with nothing read: the user is asked with a card, and the routines keep running until answered.
    const nudged = harness(away());
    const result = await nudged.runtime.apply(nudged.session, { id: "routine-1" });
    assert.equal(result.paused, false);
    assert.equal(result.reminder?.includes(`${SPEND_GUARD_MIN_UNREAD_COUNT} of your messages are unread`), true);
    const card = nudged.entries[0] as { kind: string; message: { widget: { prompt: string } } };
    assert.equal(card.kind, "send-message");
    assert.equal(card.message.widget.prompt, buildSpendGuardNudgeWidget().prompt);
    assert.deepEqual({ nudged: nudged.state().nudgedAtMs !== null, cards: nudged.state().cardEntryIds.length }, { nudged: true, cards: 1 });
    assert.deepEqual(nudged.kinds("mark-activity").length, 1);
    assert.deepEqual(nudged.kinds("roster").map((call) => call[1]), ["agent-1"]);
  });

  it("does not ask twice, and pauses the routines the user never answered about", async () => {
    // Asked already and still unanswered: the card is not issued again.
    const waiting = harness({ ...away(), state: { nudgedAtMs: Date.now() - 1_000, cardEntryIds: ["card-1"] } });
    assert.deepEqual(await waiting.runtime.apply(waiting.session, { id: "routine-1" }), { paused: false });
    waiting.runtime.issueCardIfNone(waiting.session);
    assert.deepEqual(waiting.kinds("append-db"), []);
    assert.equal(waiting.state().cardEntryIds.length, 1);

    // Long enough without an answer: every enabled routine is turned off, the user is told, and the change is recorded.
    const paused = harness({ ...away(), state: { nudgedAtMs: Date.now() - SPEND_GUARD_PAUSE_DELAY_MS - 1, cardEntryIds: ["card-1"] } });
    assert.deepEqual(await paused.runtime.apply(paused.session, { id: "routine-1" }), { paused: true });
    assert.deepEqual(paused.definitions.map((automation) => automation.isEnabled), [false, false]);
    assert.deepEqual(paused.state().pausedAutomationIds, ["routine-1"]);
    assert.deepEqual(paused.trays.map((tray) => tray.dedupeKey), ["spend-guard-paused:agent-1"]);
    assert.equal(paused.trays[0]?.title, "Routines paused while you were away");
    const pauseCard = paused.entries.at(-1) as { message: { widget: { prompt: string } } };
    assert.equal(pauseCard.message.widget.prompt, buildSpendGuardPausedWidget().prompt);
    // Nobody is looking at this conversation, so what changed while it was inactive is recorded as such.
    assert.deepEqual(paused.kindsOf("inactive-changes").map((call) => call[1]), ["agent", "spend_guard"]);
    assert.deepEqual(paused.kindsOf("mutation").map((call) => call[1]), ["agent-1"]);
  });

  it("carries out what the user answered, and says what it did", async () => {
    for (const [value, answer] of [["spend-guard:keep", "keep"], ["spend-guard:resume", "resume"], ["spend-guard:never-ask", "optOut"], ["spend-guard:pause", "pause"], ["spend-guard:stay-paused", "stayPaused"]] as const) {
      const asksAboutPausing = answer === "resume" || answer === "stayPaused";
      const card = { kind: "send-message", id: "card-9", message: { type: "widget", widget: asksAboutPausing ? buildSpendGuardPausedWidget() : buildSpendGuardNudgeWidget() }, timestampMs: 1 };
      const world = harness({ ...away(), entries: [card], state: { nudgedAtMs: 1, cardEntryIds: ["card-9"], pausedAutomationIds: ["routine-1"] } });
      world.definitions[0]!.isEnabled = false;
      const acked: string[] = [];
      const ack = await world.runtime.handleWidgetAnswer({ agentId: "agent-1", entryId: "card-9", value, onApplied: (text) => { acked.push(text); } });
      assert.equal(typeof ack, "string");
      const expected = SPEND_GUARD_ANSWER_OUTCOMES[answer];
      // The routines end up where the answer says, and the card stops being one to answer.
      const resumed = expected.routines === "resume-guard-paused";
      const allOff = expected.routines === "disable-every-enabled";
      assert.deepEqual(world.definitions.map((automation) => automation.isEnabled), resumed ? [true, false] : allOff ? [false, false] : [false, false]);
      assert.equal(world.state().snoozedUntilMs !== null, expected.snoozes);
      assert.equal(world.state().optedOut, expected.retiresGuard);
      // The card stays answerable only while the guard still has routines of its own to give back.
      assert.deepEqual(world.state().cardEntryIds, allOff ? ["card-9"] : []);
      assert.equal(acked.length, 1);
      assert.equal(ack?.includes("ALREADY applied that itself"), true);
      assert.deepEqual(world.kindsOf("config-changed").length, 1);
      assert.deepEqual(world.kindsOf("emit-automations").length, 1);
    }
  });

  it("does not carry out an answer that was not asked for", async () => {
    const nudgeCard = { kind: "send-message", id: "card-9", message: { type: "widget", widget: buildSpendGuardNudgeWidget() }, timestampMs: 1 };
    // An answer the platform does not know, an agent that is gone, a card that is not there, and a card this host did
    // not issue are all left alone.
    const unknownAnswer = harness({ ...away(), entries: [nudgeCard], state: { cardEntryIds: ["card-9"] } });
    assert.equal(await unknownAnswer.runtime.handleWidgetAnswer({ agentId: "agent-1", entryId: "card-9", value: "not-an-answer" }), null);
    const gone = harness({ ...away(), entries: [nudgeCard], state: { cardEntryIds: ["card-9"] } });
    assert.equal(await gone.runtime.handleWidgetAnswer({ agentId: "gone", entryId: "card-9", value: SPEND_GUARD_ANSWER_VALUES.keep }), null);
    const notThere = harness({ ...away(), entries: [nudgeCard], state: { cardEntryIds: ["card-9"] } });
    assert.equal(await notThere.runtime.handleWidgetAnswer({ agentId: "agent-1", entryId: "card-1", value: SPEND_GUARD_ANSWER_VALUES.keep }), null);
    const foreign = harness({ ...away(), entries: [{ kind: "send-message", id: "card-1", message: { type: "widget", widget: { prompt: "another card", options: [{ label: "x", value: SPEND_GUARD_ANSWER_VALUES.keep }] } }, timestampMs: 1 }], state: { cardEntryIds: ["card-1"] } });
    assert.equal(await foreign.runtime.handleWidgetAnswer({ agentId: "agent-1", entryId: "card-1", value: SPEND_GUARD_ANSWER_VALUES.keep }), null);
    // Nothing was changed anywhere along the way.
    for (const world of [unknownAnswer, gone, notThere, foreign]) {
      assert.deepEqual(world.kindsOf("config-changed"), []);
      assert.deepEqual(world.definitions.map((automation) => automation.isEnabled), [true, false]);
    }
  });

  it("records what the guard did in a conversation nobody is looking at, and in one they are", async () => {
    const overdue = { nudgedAtMs: Date.now() - SPEND_GUARD_PAUSE_DELAY_MS - 1, cardEntryIds: ["card-1"] };
    // Off screen, the card goes into the conversation's own store and the routines are recorded as changed while it
    // was inactive.
    const offScreen = harness({ ...away(), id: "agent-2", state: overdue });
    await offScreen.runtime.apply(offScreen.session, { id: "routine-1" });
    assert.deepEqual(offScreen.kindsOf("append-db").length, 1);
    assert.deepEqual(offScreen.kindsOf("append-active"), []);
    assert.deepEqual(offScreen.kindsOf("inactive-changes").map((call) => call[1]), ["agent", "spend_guard"]);
    // On screen, it goes into the transcript in memory and the changes are recorded as the conversation's own.
    const onScreen = harness({ ...away(), id: "agent-3", state: overdue });
    onScreen.manager.sessions.activeSession = onScreen.session;
    await onScreen.runtime.apply(onScreen.session, { id: "routine-1" });
    assert.deepEqual(onScreen.kindsOf("append-active").length, 1);
    assert.deepEqual(onScreen.kindsOf("append-db"), []);
    assert.deepEqual(onScreen.kindsOf("change-events").map((call) => call[1]), ["agent", "spend_guard"]);
    // Asking the user a question changes no routine, so nothing is recorded as changed.
    const asked = harness({ ...away(), id: "agent-4" });
    await asked.runtime.apply(asked.session, { id: "routine-1" });
    assert.deepEqual(asked.kindsOf("append-db").length, 1);
    assert.deepEqual(asked.kindsOf("inactive-changes"), []);
    assert.deepEqual(asked.kindsOf("change-events"), []);
  });

  it("keeps the outcome table complete, and snoozes exactly where it says", () => {
    assert.deepEqual(SPEND_GUARD_ANSWER_OUTCOMES.resume, { routines: "resume-guard-paused", snoozes: true, retiresGuard: false });
  });

  it("issues the nudge card for an awaiting answer that has none", async () => {
    const waiting = harness({ ...away(), state: { nudgedAtMs: Date.now() - 1_000, cardEntryIds: [] } });
    assert.deepEqual(await waiting.runtime.apply(waiting.session, { id: "routine-1" }), { paused: false });
    assert.deepEqual(waiting.state().cardEntryIds.length, 1, "an awaiting answer with no card gets one");
  });

  it("does not add another card when a pause is already open", async () => {
    const paused = harness({
      ...away(),
      state: { nudgedAtMs: Date.now() - SPEND_GUARD_PAUSE_DELAY_MS - 1, cardEntryIds: ["card-1"], pausedAutomationIds: ["routine-1"] },
    });
    await paused.runtime.apply(paused.session, { id: "routine-1" });
    assert.equal(paused.state().cardEntryIds.length, 1, "the open pause keeps its card");
  });

  it("does not touch a routine that is already enabled when resuming", () => {
    const { automations, calls, definitions } = conversation();
    reEnableGuardPausedRoutines({ automations } as never, ["routine-1", "routine-2"]);
    assert.deepEqual(definitions.map((automation) => automation.isEnabled), [true, true]);
    assert.deepEqual(calls.map((call) => [call[0], call[1], call[2]]), [["set-enabled", "routine-2", true]], "only the disabled one is set");
  });

  it("issues a card when none is open", () => {
    const world = harness({ state: { cardEntryIds: [] } });
    world.runtime.issueCardIfNone(world.session);
    assert.equal(world.state().cardEntryIds.length, 1);
  });
});
