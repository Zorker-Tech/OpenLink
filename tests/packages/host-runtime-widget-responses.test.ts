/**
 * The cards in a conversation: answering one, dismissing it, reacting to a message, and retiring the cards that went
 * stale — what is written onto the entry, what the agent is told, and what happens when an answer cannot be stored.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getTranscript, setTranscript } from "../../source/host/transcript/transcript-store.ts";
import type { TranscriptEntry } from "../../source/host/transcript/transcript-hub.ts";
import { WidgetResponses } from "../../source/host/transcript/widget-responses.ts";
import { SLATE_REACTION_SELF } from "../../source/shared/transcript.ts";

type Call = { name: string; args: unknown[] };
type SessionLike = { id: string; db: { getTranscriptEntries: () => TranscriptEntry[] } };

const WIDGET = {
  type: "widget",
  widget: { prompt: "Pick one", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }] },
};
const widgetEntry = (id: string, fields: Record<string, unknown> = {}): TranscriptEntry => ({
  id,
  kind: "send-message",
  message: structuredClone(WIDGET),
  ...fields,
});
const messageEntry = (id: string, fields: Record<string, unknown> = {}): TranscriptEntry => ({
  id,
  kind: "message",
  role: "assistant",
  content: "hello there",
  ...fields,
});
const permissionEntry = (id: string, requestId: string, status = "pending"): TranscriptEntry => ({
  id,
  kind: "send-message",
  message: { type: "local-tool-permission", ask: { requestId, status } },
});
const approvalEntry = (id: string, requestId: string, status = "pending"): TranscriptEntry => ({
  id,
  kind: "send-message",
  message: { type: "auto-review-approval", approval: { requestId, status } },
});
const moveOnWidget = (id: string): TranscriptEntry =>
  widgetEntry(id, { message: { ...structuredClone(WIDGET), widget: { ...structuredClone(WIDGET.widget), dismissOnMoveOn: true } } });

/**
 * A transcript manager with the two copies a conversation actually has: the store the timeline reads, and the session's
 * own entries. Every call it receives is written down, so a test can assert what a card did and what it left alone.
 */
function world(
  options: {
    entries?: TranscriptEntry[];
    sessionEntries?: TranscriptEntry[];
    sessionId?: string | null;
    liveSessions?: Array<[string, TranscriptEntry[]]>;
    sessionStore?: Record<string, unknown>;
    spendGuard?: (args: { agentId: string; entryId: string; value: string; onApplied: () => void }) => Promise<string | null>;
    sendPromptError?: Error;
    storeCredential?: boolean;
  } = {},
) {
  const storeEntries = structuredClone(options.entries ?? []);
  const sessionEntries = structuredClone(options.sessionEntries ?? options.entries ?? []);
  setTranscript(storeEntries);
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const makeDb = (entries: TranscriptEntry[]) => ({
    getTranscriptEntries: () => entries,
    updateTranscriptEntry: (id: string, update: (entry: TranscriptEntry) => TranscriptEntry) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) return null;
      const updated = update(entries[index] as TranscriptEntry);
      entries[index] = updated;
      return updated;
    },
  });
  const db = makeDb(sessionEntries);
  const sessionId = options.sessionId === undefined ? "agent-1" : options.sessionId;
  const activeSession = sessionId === null ? null : { id: sessionId, db };
  const liveSessions = new Map<string, unknown>();
  if (activeSession !== null) liveSessions.set(activeSession.id, activeSession);
  for (const [id, entries] of options.liveSessions ?? []) liveSessions.set(id, { id, db: makeDb(structuredClone(entries)) });
  const tm = {
    sessions: {
      activeSession,
      liveSessions,
      ensureActionTarget: async (agentId: string) => record("ensureActionTarget", agentId),
    },
    roster: {
      emit: (event: unknown, agentId?: string) => record("emit", event, agentId),
      emitAgentUpdate: (agentId: string) => record("emitAgentUpdate", agentId),
    },
    sendPrompt: async (prompt: string, promptOptions: unknown) => {
      record("sendPrompt", prompt, promptOptions);
      if (options.sendPromptError !== undefined) throw options.sendPromptError;
    },
    automationRuntime: {
      handleSpendGuardWidgetAnswer: async (args: never) => {
        record("spendGuard", args);
        return options.spendGuard === undefined ? null : options.spendGuard(args as never);
      },
    },
    sessionStore: {
      listAgentIds: async () => [],
      readAgentTranscriptEntries: () => [],
      expirePendingAutoReviewApprovals: async () => [],
      expirePendingLocalToolPermissionAsks: async () => [],
      storeConnectorCredential: (agentId: string, platform: string, field: string, value: string) => {
        record("storeConnectorCredential", agentId, platform, field, value);
        return options.storeCredential ?? true;
      },
      ...options.sessionStore,
    },
    trayErrors: { pushError: (error: unknown) => record("pushError", error) },
    boxHandoff: {
      resumeWithHiddenPrompt: async (agentId: string, prompt: string, failure: string) => record("resume", agentId, prompt, failure),
    },
    telemetry: { reportAutoReviewExpireSweepFailed: (report: unknown) => record("sweepFailed", report) },
    channelConfigChanged: () => record("channelConfigChanged"),
  };
  return {
    cards: new WidgetResponses(tm),
    tm,
    calls,
    sessionEntries,
    named: (name: string) => calls.filter((call) => call.name === name),
    stored: (id: string) => getTranscript().find((entry) => entry.id === id),
    persisted: (id: string) => sessionEntries.find((entry) => entry.id === id),
    lastEmitted: () => (calls.filter((call) => call.name === "emit").at(-1)?.args[0] ?? null) as { type: string; entry: TranscriptEntry } | null,
  };
}

describe("answering a card", () => {
  it("stamps an answer on the card, in the timeline and on the session, and refuses anything that is not an open widget", () => {
    const world1 = world({ entries: [widgetEntry("w0", { respondedValue: "yes" }), widgetEntry("w1"), messageEntry("m1")] });
    assert.equal(world1.cards.recordWidgetResponse("w1", "yes"), true);
    assert.equal(world1.stored("w1")?.respondedValue, "yes");
    assert.equal(world1.persisted("w1")?.respondedValue, "yes");
    assert.equal(world1.lastEmitted()?.type, "updated");
    assert.equal(world1.lastEmitted()?.entry.respondedValue, "yes");
    // An already answered card, a dismissed card, a non-widget entry, and an id nobody has are all refused.
    assert.equal(world1.cards.recordWidgetResponse("w1", "no"), false);
    assert.equal(world1.cards.recordWidgetResponse("w0", "no"), false);
    assert.equal(world1.cards.recordWidgetResponse("m1", "yes"), false);
    assert.equal(world1.cards.recordWidgetResponse("nobody", "yes"), false);
    assert.equal(world1.named("emit").length, 1);
    const dismissed = world({ entries: [widgetEntry("w2", { widgetDismissed: true })] });
    assert.equal(dismissed.cards.recordWidgetResponse("w2", "yes"), false);
    assert.equal(dismissed.named("emit").length, 0);
  });

  it("leaves a card alone when a later user moment already moved the conversation on", () => {
    // This card asks to be dismissed on move-on, and a later user message is exactly that.
    const movedOn = world({ entries: [moveOnWidget("w1"), messageEntry("m1", { role: "user" })] });
    assert.equal(movedOn.cards.recordWidgetResponse("w1", "yes"), false);
    assert.equal(movedOn.stored("w1")?.respondedValue, undefined);
    assert.equal(movedOn.named("emit").length, 0);
    // An assistant message is not a user moment; a later answered card is.
    const agentSpoke = world({ entries: [moveOnWidget("w1"), messageEntry("m1")] });
    assert.equal(agentSpoke.cards.recordWidgetResponse("w1", "yes"), true);
    const laterCard = world({ entries: [moveOnWidget("w1"), widgetEntry("w2", { respondedValue: "no" })] });
    assert.equal(laterCard.cards.recordWidgetResponse("w1", "yes"), false);
    // Without the flag a later user moment does not matter.
    const flagged = world({ entries: [widgetEntry("w1", { message: { ...structuredClone(WIDGET), widget: { ...structuredClone(WIDGET.widget), dismissOnMoveOn: false } } }), messageEntry("m1", { role: "user" })] });
    assert.equal(flagged.cards.recordWidgetResponse("w1", "yes"), true);
  });

  it("takes an answer back off a card when it could not be delivered", () => {
    const world1 = world({ entries: [widgetEntry("w1")] });
    assert.equal(world1.cards.recordWidgetResponse("w1", "yes"), true);
    const rolled = world1.cards.rollbackWidgetResponse("w1");
    assert.equal(rolled?.respondedValue, undefined);
    assert.equal(world1.stored("w1")?.respondedValue, undefined);
    assert.equal(world1.persisted("w1")?.respondedValue, undefined);
    assert.equal(world1.cards.rollbackWidgetResponse("nobody"), null);
  });

  it("sends what the card said to the agent that owns the conversation, replying to what the card replied to", async () => {
    const world1 = world({ entries: [widgetEntry("w1", { replyTo: "m0" })], sessionId: "agent-7" });
    assert.deepEqual(await world1.cards.respondToWidget("w1", "  yes  ", "agent-7"), { accepted: true });
    assert.deepEqual(world1.named("ensureActionTarget")[0]?.args, ["agent-7"]);
    assert.deepEqual(world1.named("sendPrompt")[0]?.args, [
      "yes",
      { agentId: "agent-7", replyToId: "m0", appendUserMessage: false, awaitTurn: false },
    ]);
    // Nothing at all goes out for an empty answer, and an answer that cannot be recorded is not sent either.
    const empty = world({ entries: [widgetEntry("w1")] });
    assert.deepEqual(await empty.cards.respondToWidget("w1", "   ", "agent-1"), { accepted: false });
    assert.equal(empty.named("ensureActionTarget").length, 0);
    const answered = world({ entries: [widgetEntry("w1", { respondedValue: "yes" })] });
    assert.deepEqual(await answered.cards.respondToWidget("w1", "no", "agent-1"), { accepted: false });
    assert.equal(answered.named("sendPrompt").length, 0);
  });

  it("hands a guard answer to the automation runtime first, and sends what it says instead", async () => {
    let applied = 0;
    let guarded: { agentId: string; entryId: string; value: string } | undefined;
    const guard = world({
      entries: [widgetEntry("w1")],
      spendGuard: async (args) => {
        guarded = { agentId: args.agentId, entryId: args.entryId, value: args.value };
        args.onApplied();
        applied += 1;
        return "The user chose to keep spending.";
      },
    });
    assert.deepEqual(await guard.cards.respondToWidget("w1", "spend-guard:keep", "agent-1"), { accepted: true });
    assert.equal(applied, 1);
    assert.deepEqual(guarded, { agentId: "agent-1", entryId: "w1", value: "spend-guard:keep" });
    assert.equal(guard.named("spendGuard").length, 1);
    assert.equal(guard.named("sendPrompt")[0]?.args[0], "The user chose to keep spending.");
    // A guard that cannot settle the answer means the card is left unanswered.
    const refused = world({ entries: [widgetEntry("w1")], spendGuard: async () => null });
    assert.deepEqual(await refused.cards.respondToWidget("w1", "spend-guard:pause", "agent-1"), { accepted: false });
    assert.equal(refused.stored("w1")?.respondedValue, undefined);
    assert.equal(refused.named("sendPrompt").length, 0);
    // Once the guard has been applied the answer stands even if sending it fails.
    const halfWay = world({
      entries: [widgetEntry("w1")],
      sendPromptError: new Error("send failed"),
      spendGuard: async (args) => {
        args.onApplied();
        return "applied";
      },
    });
    assert.deepEqual(await halfWay.cards.respondToWidget("w1", "spend-guard:keep", "agent-1"), { accepted: true });
    assert.equal(halfWay.stored("w1")?.respondedValue, "spend-guard:keep");
    // Without the guard, a failed send takes the answer back off the card and is reported.
    const failed = world({ entries: [widgetEntry("w1")], sendPromptError: new Error("send failed") });
    await assert.rejects(() => failed.cards.respondToWidget("w1", "yes", "agent-1"), /send failed/);
    assert.equal(failed.stored("w1")?.respondedValue, undefined);
  });
});

describe("dismissing a card and moving past one", () => {
  it("dismisses an open card, clearing the flag that said it was skipped", async () => {
    const world1 = world({ entries: [widgetEntry("w1", { widgetSkipped: true })] });
    assert.deepEqual(await world1.cards.dismissWidget({ entryId: "w1", agentId: "agent-1" }), { accepted: true });
    assert.equal(world1.stored("w1")?.widgetDismissed, true);
    assert.equal(world1.stored("w1")?.widgetSkipped, undefined);
    assert.equal(world1.persisted("w1")?.widgetDismissed, true);
    assert.equal(world1.named("emit").length, 1);
    // Dismissing again, or something that is not an open widget, is refused.
    assert.deepEqual(await world1.cards.dismissWidget({ entryId: "w1", agentId: "agent-1" }), { accepted: false });
    const message = world({ entries: [messageEntry("m1")] });
    assert.deepEqual(await message.cards.dismissWidget({ entryId: "m1", agentId: "agent-1" }), { accepted: false });
    assert.equal(message.named("emit").length, 0);
  });

  it("collects the prompts the user moved past, marking each one skipped and separating the dismissed", () => {
    const world1 = world({
      entries: [
        widgetEntry("w1"),
        widgetEntry("w2", { widgetDismissed: true }),
        widgetEntry("w3", { widgetSkipped: true }),
        widgetEntry("w4", { respondedValue: "yes" }),
        messageEntry("m1"),
      ],
    });
    assert.deepEqual(world1.cards.collectUnansweredQuestionPrompts(world1.tm.sessions.activeSession), {
      skippedQuestionPrompts: ["Pick one — Yes / No"],
      dismissedQuestionPrompts: ["Pick one — Yes / No"],
    });
    assert.equal(world1.stored("w1")?.widgetSkipped, true);
    assert.equal(world1.stored("w2")?.widgetSkipped, true);
    assert.equal(world1.stored("w3")?.widgetSkipped, true);
    assert.equal(world1.stored("w4")?.widgetSkipped, undefined);
    // The open conversation emits an update per card it marked; a conversation open on the side does not.
    assert.equal(world1.named("emit").length, 2);
    const side = world({ sessionId: null, liveSessions: [["agent-2", [widgetEntry("s1")]]] });
    const session = side.tm.sessions.liveSessions.get("agent-2") as SessionLike;
    assert.deepEqual(side.cards.collectUnansweredQuestionPrompts(session), {
      skippedQuestionPrompts: ["Pick one — Yes / No"],
      dismissedQuestionPrompts: [],
    });
    assert.equal(session.db.getTranscriptEntries()[0]?.widgetSkipped, true);
    assert.equal(side.named("emit").length, 0);
  });
});

describe("cards that went stale", () => {
  it("retires a pending auto-review card on the session it is open in, and says which agent changed", () => {
    const world1 = world({ entries: [approvalEntry("a1", "r1"), approvalEntry("a2", "r2"), approvalEntry("a3", "r1", "approved")] });
    assert.equal(world1.cards.settlePendingAutoReviewApprovalsOnSession({ agentId: "agent-1", status: "expired", requestId: "r1" }), true);
    const statusOf = (id: string) => (world1.persisted(id)?.message as { approval: { status: string } }).approval.status;
    assert.equal(statusOf("a1"), "expired");
    assert.equal(statusOf("a2"), "pending");
    assert.equal(statusOf("a3"), "approved");
    assert.deepEqual(world1.lastEmitted(), { type: "updated", entry: world1.stored("a1") });
    assert.deepEqual(world1.named("emit")[0]?.args[1], "agent-1");
    // Once nothing is pending, there is nothing to retire; an agent with no open conversation has nothing either.
    assert.equal(world1.cards.settlePendingAutoReviewApprovalsOnSession({ agentId: "agent-1", status: "expired", requestId: "r1" }), false);
    assert.equal(world1.cards.settlePendingAutoReviewApprovalsOnSession({ agentId: "no-such-agent", status: "expired" }), false);
    // Without a request id, every pending card is retired.
    const all = world({ entries: [approvalEntry("a1", "r1"), approvalEntry("a2", "r2")] });
    assert.equal(all.cards.settlePendingAutoReviewApprovalsOnSession({ agentId: "agent-1", status: "expired" }), true);
    assert.equal(all.persisted("a1")?.message && (all.persisted("a1")?.message as { approval: { status: string } }).approval.status, "expired");
    assert.equal((all.persisted("a2")?.message as { approval: { status: string } }).approval.status, "expired");
  });

  it("falls back to the stored cards when the conversation is not open, and claims nothing it did not retire", async () => {
    const expiredCalls: unknown[][] = [];
    const stored = approvalEntry("a1", "r9", "expired");
    const fromStore = world({
      sessionId: null,
      sessionStore: {
        expirePendingAutoReviewApprovals: async (agentId: string, requestId?: string) => {
          expiredCalls.push([agentId, requestId]);
          return [{ id: "a1" }];
        },
        readAgentTranscriptEntries: () => [stored],
      },
    });
    assert.equal(await fromStore.cards.settleStaleAutoReviewCard({ agentId: "agent-2", entryId: "a1", requestId: "r9" }), true);
    assert.deepEqual(expiredCalls, [["agent-2", "r9"]]);
    assert.deepEqual(fromStore.named("emitAgentUpdate")[0]?.args, ["agent-2"]);
    assert.deepEqual(fromStore.named("emit")[0]?.args, [{ type: "updated", entry: stored }, "agent-2"]);
    // The store expired something else, so the card the caller named is not the one that was settled.
    const mismatch = world({
      sessionId: null,
      sessionStore: {
        expirePendingAutoReviewApprovals: async () => [{ id: "other" }],
        readAgentTranscriptEntries: () => [approvalEntry("a1", "r8", "expired")],
      },
    });
    assert.equal(await mismatch.cards.settleStaleAutoReviewCard({ agentId: "agent-2", entryId: "a1", requestId: "r9" }), false);
    assert.equal(mismatch.named("emit").length, 0);
    // Nothing was pending anywhere, so there is nothing to claim and nothing to announce.
    const quiet = world({
      sessionId: null,
      sessionStore: { expirePendingAutoReviewApprovals: async () => [], readAgentTranscriptEntries: () => [] },
    });
    assert.equal(await quiet.cards.settleStaleAutoReviewCard({ agentId: "agent-2", entryId: "a1", requestId: "r9" }), false);
    assert.equal(quiet.named("emitAgentUpdate").length, 0);
  });

  it("sweeps every other conversation for stale auto-review cards, and reports where the sweep failed", async () => {
    const swept: string[] = [];
    const sweep = world({
      sessionStore: {
        listAgentIds: async () => ["agent-1", "agent-2", "agent-3"],
        expirePendingAutoReviewApprovals: async (agentId: string) => {
          swept.push(agentId);
          if (agentId === "agent-3") throw Object.assign(new Error("store is down"), { code: "EIO" });
          return agentId === "agent-2" ? [{ id: "a9" }] : [];
        },
      },
    });
    await sweep.cards.expireAllPendingAutoReviewApprovalCards();
    // The open conversation is settled from its own session, not through the store, and the sweep carries on past a
    // conversation whose store failed.
    assert.deepEqual(swept, ["agent-2", "agent-3"]);
    assert.deepEqual(sweep.named("emitAgentUpdate").map((call) => call.args[0]), ["agent-2"]);
    assert.deepEqual(sweep.named("sweepFailed").map((call) => (call.args[0] as { stage: string }).stage), ["expire_agent"]);
    // A store that cannot even list the conversations is reported as such and the sweep stops there.
    const cannotList = world({ sessionStore: { listAgentIds: async () => { throw new Error("nope"); } } });
    await cannotList.cards.expireAllPendingAutoReviewApprovalCards();
    assert.deepEqual(cannotList.named("sweepFailed").map((call) => (call.args[0] as { stage: string }).stage), ["list_agents"]);
  });

  it("retires pending tool-permission cards, honouring the moment they were asked", async () => {
    const world1 = world({ entries: [permissionEntry("p1", "q1")] });
    assert.equal(await world1.cards.settleStaleLocalToolPermissionCard({ agentId: "agent-1", entryId: "p1", requestId: "q1" }), "retired");
    assert.equal((world1.persisted("p1")?.message as { ask: { status: string } }).ask.status, "expired");
    assert.deepEqual(world1.named("emit")[0]?.args, [{ type: "updated", entry: world1.stored("p1") }, "agent-1"]);
    // Nothing left pending on that card means there is nothing to retire.
    assert.equal(world1.cards.settlePendingLocalToolPermissionAsksOnSession({ agentId: "agent-1" }), false);
    // A card that was settled elsewhere is recognised as such rather than claimed.
    const settled = world({
      sessionId: null,
      sessionStore: {
        expirePendingLocalToolPermissionAsks: async () => [],
        readAgentTranscriptEntries: () => [permissionEntry("p1", "q1", "expired")],
      },
    });
    assert.equal(await settled.cards.settleStaleLocalToolPermissionCard({ agentId: "agent-2", entryId: "p1", requestId: "q1" }), "already-settled");
    assert.equal(settled.named("emit").length, 1);
    const nothing = world({ sessionId: null, sessionStore: { expirePendingLocalToolPermissionAsks: async () => [], readAgentTranscriptEntries: () => [] } });
    assert.equal(await nothing.cards.settleStaleLocalToolPermissionCard({ agentId: "agent-2", entryId: "p1", requestId: "q1" }), false);
    // A card asked after the cutoff is left alone, even though it is still pending.
    const recent = world({
      sessionId: null,
      liveSessions: [["agent-2", [{ ...permissionEntry("p1", "q1"), timestampMs: 5_000 }]]],
      sessionStore: { expirePendingLocalToolPermissionAsks: async () => [], readAgentTranscriptEntries: () => [] },
    });
    assert.equal(recent.cards.settlePendingLocalToolPermissionAsksOnSession({ agentId: "agent-2", ifPendingBeforeMs: 1_000 }), false);
    assert.equal((recent.tm.sessions.liveSessions.get("agent-2") as SessionLike).db.getTranscriptEntries()[0]?.message !== undefined, true);
    assert.deepEqual((recent.tm.sessions.liveSessions.get("agent-2") as SessionLike).db.getTranscriptEntries()[0]?.message, permissionEntry("p1", "q1").message);
    // A sweep on conversations whose store fails is quietly skipped rather than reported.
    const sweeping = world({
      sessionStore: {
        listAgentIds: async () => ["agent-2"],
        expirePendingLocalToolPermissionAsks: async () => {
          throw new Error("store is down");
        },
      },
    });
    await assert.doesNotReject(() => sweeping.cards.expireAllPendingLocalToolPermissionCards({ ifPendingBeforeMs: 1_000 }));
    assert.equal(sweeping.named("sweepFailed").length, 0);
  });
});

describe("secrets and reactions", () => {
  it("stores a secret where its card says, marks the card, and resumes the agent with an acknowledgement", async () => {
    const request = { label: "Slack token", target: { kind: "channel-credential", platform: "slack", field: "token" } };
    const secret = (): TranscriptEntry => ({ id: "s1", kind: "send-message", message: { type: "secret-request", secretRequest: request } });
    const world1 = world({ entries: [secret()] });
    await world1.cards.submitSecret("s1", "  xoxb-1  ", "agent-1");
    assert.deepEqual(world1.named("storeConnectorCredential")[0]?.args, ["agent-1", "slack", "token", "xoxb-1"]);
    assert.equal(world1.named("channelConfigChanged").length, 1);
    assert.equal(world1.stored("s1")?.secretProvided, true);
    assert.equal(world1.persisted("s1")?.secretProvided, true);
    const resumed = world1.named("resume")[0]?.args ?? [];
    assert.equal(resumed[0], "agent-1");
    assert.match(String(resumed[1]), /Slack token/);
    assert.match(String(resumed[1]), /channel-credential/);
    assert.equal(resumed[2], "Agent failed to resume after secret submission");
    // The card is not written again once it has its secret. (The store the card is read from is the module's current
    // one, so this has to be checked while this conversation is still the current one.)
    await world1.cards.submitSecret("s1", "xoxb-1", "agent-1");
    assert.equal(world1.named("storeConnectorCredential").length, 1);
    assert.equal(world1.named("resume").length, 1);
    // A secret that cannot be stored leaves the card alone and says so.
    const refused = world({ entries: [secret()], storeCredential: false });
    await refused.cards.submitSecret("s1", "xoxb-1", "agent-1");
    assert.equal(refused.stored("s1")?.secretProvided, undefined);
    assert.equal(refused.named("resume").length, 0);
    assert.deepEqual(refused.named("pushError")[0]?.args[0], {
      agentId: "agent-1",
      title: "Could not store the secret",
      detail: "The secure input could not write the credential to its store.",
    });
    // A target that is not a channel credential has nowhere to go, even when the credential store is working.
    const wrongTarget = world({
      entries: [{ id: "s2", kind: "send-message", message: { type: "secret-request", secretRequest: { label: "Key", target: { kind: "file", path: "/tmp/key" } } } }],
    });
    assert.equal(wrongTarget.cards.routeSecret("agent-1", { kind: "other" }, "v"), false);
    await wrongTarget.cards.submitSecret("s2", "v", "agent-1");
    assert.equal(wrongTarget.named("storeConnectorCredential").length, 0);
    assert.equal(wrongTarget.named("resume").length, 0);
    assert.equal(wrongTarget.named("pushError").length, 1);
    // An empty value does nothing at all.
    const empty = world({ entries: [secret()] });
    await empty.cards.submitSecret("s1", "   ", "agent-1");
    assert.equal(empty.calls.length, 0);
  });

  it("toggles a reaction on a message and resumes the agent only when the reacted message is its own", async () => {
    const world1 = world({ entries: [messageEntry("m1")] });
    const added = world1.cards.applyReaction({ session: world1.tm.sessions.activeSession, entryId: "m1", emoji: "👍", by: SLATE_REACTION_SELF });
    assert.equal(added?.isAdding, true);
    assert.deepEqual(world1.stored("m1")?.reactions, [{ emoji: "👍", by: "me" }]);
    assert.equal(world1.named("emit").length, 1);
    const removed = world1.cards.applyReaction({ session: world1.tm.sessions.activeSession, entryId: "m1", emoji: "👍", by: SLATE_REACTION_SELF });
    assert.equal(removed?.isAdding, false);
    assert.equal(world1.stored("m1")?.reactions, undefined);
    assert.equal(world1.cards.applyReaction({ session: world1.tm.sessions.activeSession, entryId: "nobody", emoji: "👍", by: SLATE_REACTION_SELF }), null);
    // Somebody else's reaction on the same message does not make this one a removal.
    const others = world({ entries: [messageEntry("m1", { reactions: [{ emoji: "👍", by: "agent" }] })] });
    const mine = others.cards.applyReaction({ session: others.tm.sessions.activeSession, entryId: "m1", emoji: "👍", by: SLATE_REACTION_SELF });
    assert.equal(mine?.isAdding, true);
    assert.deepEqual(others.stored("m1")?.reactions, [{ emoji: "👍", by: "agent" }, { emoji: "👍", by: "me" }]);
    // Reacting to the agent's own message tells it, quoting the message with its whitespace squeezed out.
    const reacting = world({ entries: [messageEntry("m1", { content: "hello   there\nworld" })] });
    await reacting.cards.reactToMessage("m1", " 👍 ", "agent-1");
    assert.deepEqual(reacting.named("ensureActionTarget")[0]?.args, ["agent-1"]);
    assert.deepEqual(reacting.named("resume")[0]?.args, [
      "agent-1",
      `[The user reacted 👍 to your message: "hello there world". You don't need to reply; act on it only if it's useful (e.g. acknowledge, adjust, or continue).]`,
      "Agent failed to resume after reaction",
    ]);
    // Reacting to the user's own message does not wake the agent, and an empty reaction does nothing.
    const own = world({ entries: [messageEntry("m1", { role: "user" })] });
    await own.cards.reactToMessage("m1", "👍", "agent-1");
    assert.equal(own.named("resume").length, 0);
    const blank = world({ entries: [messageEntry("m1")] });
    await blank.cards.reactToMessage("m1", "  ", "agent-1");
    assert.equal(blank.calls.length, 0);
    // On a conversation that is not open, the reaction is written to its own entries and its roster is refreshed.
    const side = world({ sessionId: null, liveSessions: [["agent-2", [messageEntry("m1")]]] });
    const sideSession = side.tm.sessions.liveSessions.get("agent-2") as SessionLike;
    const applied = side.cards.applyReaction({ session: sideSession, entryId: "m1", emoji: "👍", by: SLATE_REACTION_SELF });
    assert.equal(applied?.isAdding, true);
    assert.deepEqual(sideSession.db.getTranscriptEntries()[0]?.reactions, [{ emoji: "👍", by: "me" }]);
    assert.deepEqual(side.named("emitAgentUpdate")[0]?.args, ["agent-2"]);
    assert.equal(side.named("emit").length, 0);
  });
});
