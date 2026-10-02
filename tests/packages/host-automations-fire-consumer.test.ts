/**
 * Polling the backend for automation fires: what an event is allowed to be, which fire is admitted, what a rejection
 * says, and how work in flight is polled, delivered, completed and backed off from.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BackendStatusError,
  ERROR_BACKOFF_MS,
  MAX_NEXT_POLL_DELAY_MS,
  SlateAutomationFireConsumer,
  admitsBareFire,
  completionOfOutcome,
  fireEventMatchesTrigger,
  parseFireTriggerEvent,
} from "../../source/host/automations/slate-automation-fire-consumer.ts";
import { slateCloudDefinition, type ScheduledCloudAutomation } from "../../source/host/automations/slate-automation-cloud-sync.ts";
import { stableAutomationId } from "../../source/host/automations/automation-id.ts";
import type { AutomationTrigger, AutomationTriggerMember } from "../../source/shared/automations.ts";
import { SlateError } from "../../source/shared/errors/registry.ts";

type Call = { name: string; args: unknown[] };

const cron = (schedule: string): AutomationTriggerMember => ({ type: "cron", schedule });
const slack = (channel: string, match: { kind: string; keyword?: string }): AutomationTriggerMember => ({ type: "slack", channel, match: match as never });
const github = (repo: string, events: string[]): AutomationTriggerMember => ({ type: "github", repo, events });
const automationOf = (overrides: Partial<ScheduledCloudAutomation> = {}): ScheduledCloudAutomation => ({
  id: "auto-1",
  name: "Morning report",
  prompt: "Write it.",
  isEnabled: true,
  trigger: cron("0 9 * * *"),
  ...overrides,
});

/** A backend that answers the two endpoints this consumer uses, with everything it was asked written down. */
function backend(options: { poll?: unknown[]; pollStatus?: number; completeStatus?: number; nextPollAfterMs?: number; failFetch?: unknown } = {}) {
  const calls: Call[] = [];
  let pollIndex = 0;
  const fetchImpl = (async (url: string, init: { body?: string }) => {
    calls.push({ name: "fetch", args: [url, JSON.parse(init.body ?? "{}")] });
    const path = new URL(url).pathname;
    if (options.failFetch !== undefined) throw options.failFetch;
    if (path === "/slate/automation-events/poll") {
      if (options.pollStatus !== undefined) return { ok: false, status: options.pollStatus, json: async () => ({}) };
      const answer = (options.poll ?? [])[pollIndex] ?? { events: [], ...(options.nextPollAfterMs === undefined ? {} : { nextPollAfterMs: options.nextPollAfterMs }) };
      pollIndex += 1;
      return { ok: true, status: 200, json: async () => answer };
    }
    if (options.completeStatus !== undefined && options.completeStatus !== 200) return { ok: false, status: options.completeStatus, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, polls: () => calls.filter((call) => String(call.args[0]).endsWith("/slate/automation-events/poll")), completes: () => calls.filter((call) => String(call.args[0]).endsWith("/slate/automation-runs/complete")) };
}

/** Let the delivery a poll started finish before asking what it did. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const fireWire = (overrides: Record<string, unknown> = {}) => ({
  id: "run-uuid-1",
  slateAgentId: "agent-1",
  automationId: stableAutomationId({ agentId: "agent-1", localId: "auto-1" }),
  timestampMs: Date.now(),
  ...overrides,
});

/** The consumer over a backend and an automation list, with what it fires and reports written down. */
function world(
  options: {
    targets?: Array<{ agentId: string; automation: ScheduledCloudAutomation }>;
    polls?: unknown[];
    pollStatus?: number;
    completeStatus?: number;
    nextPollAfterMs?: number;
    failFetch?: unknown;
    ready?: boolean;
    notifyConnected?: boolean;
    fireOutcome?: string;
    eventOutcome?: string;
    declinesFire?: boolean;
    boxUptimeMs?: number;
    timeZone?: string;
    pollError?: unknown;
  } = {},
) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const dropped: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  const backendWorld = backend({
    ...(options.polls === undefined ? {} : { poll: options.polls }),
    ...(options.pollStatus === undefined ? {} : { pollStatus: options.pollStatus }),
    ...(options.completeStatus === undefined ? {} : { completeStatus: options.completeStatus }),
    ...(options.nextPollAfterMs === undefined ? {} : { nextPollAfterMs: options.nextPollAfterMs }),
    ...(options.failFetch === undefined ? {} : { failFetch: options.failFetch }),
    ...(options.pollError === undefined ? {} : {}),
  });
  const consumer = new SlateAutomationFireConsumer({
    getAccessToken: async () => {
      record("getAccessToken");
      return "token";
    },
    getBackendUrl: () => "https://backend.invalid",
    getTimeZone: () => options.timeZone,
    getBoxUptimeMs: () => options.boxUptimeMs,
    isReady: async () => options.ready !== false,
    listAutomations: async () => {
      record("listAutomations");
      return options.targets ?? [{ agentId: "agent-1", automation: automationOf() }];
    },
    fire: async (args: unknown) => {
      record("fire", args);
      // A box that declines the fire answers with nothing rather than an outcome.
      if (options.declinesFire === true) return undefined;
      return options.fireOutcome ?? "ok";
    },
    fireForEvent: async (args: unknown) => {
      record("fireForEvent", args);
      if (options.declinesFire === true) return undefined;
      return options.eventOutcome ?? "ok";
    },
    fetchImpl: backendWorld.fetchImpl,
    telemetry: {
      reportAutomationFireDropped: (report: Record<string, unknown>) => dropped.push(report),
      reportAgentError: (report: Record<string, unknown>) => errors.push(report),
    },
    isNotifyConnected: () => options.notifyConnected === true,
    isNotifySafetyPollEnabled: () => true,
  });
  return { consumer, calls, dropped, errors, backend: backendWorld, named: (name: string) => calls.filter((call) => call.name === name) };
}

describe("what a fire's event is allowed to be", () => {
  it("accepts the six kinds of event the platforms send", () => {
    const slackEvent = parseFireTriggerEvent({ source: "slack", channel: "C1", sender: "octocat", text: "hi", isMention: true, isSelf: true, reactionEmoji: "tada", ts: "1.2", threadTs: "1.1", timestampMs: 10 });
    assert.deepEqual(slackEvent, { source: "slack", channel: "C1", sender: "octocat", text: "hi", isMention: true, isSelf: true, reactionEmoji: "tada", ts: "1.2", threadTs: "1.1", timestampMs: 10 });
    // Only the fields the platform may send are kept, and only when they are there.
    assert.deepEqual(parseFireTriggerEvent({ source: "slack", channel: "C1" }), { source: "slack", channel: "C1", sender: "someone", text: "", isMention: false, timestampMs: parseFireTriggerEvent({ source: "slack", channel: "C1" })?.timestampMs });
    assert.deepEqual(parseFireTriggerEvent({ source: "github", repo: "o/r", kind: "pr-opened", title: "t", actor: "a", url: "u", branch: "b" }), {
      source: "github",
      repo: "o/r",
      kind: "pr-opened",
      title: "t",
      actor: "a",
      url: "u",
      branch: "b",
      timestampMs: parseFireTriggerEvent({ source: "github", repo: "o/r", kind: "pr-opened" })?.timestampMs,
    });
    assert.deepEqual(parseFireTriggerEvent({ source: "microsoftTeams", tenantId: "t", teamId: "team", channelId: "c", text: "hi" }), {
      source: "microsoftTeams",
      tenantId: "t",
      teamId: "team",
      channelId: "c",
      text: "hi",
      aadObjectId: "unknown",
      activityId: "unknown",
      timestampMs: parseFireTriggerEvent({ source: "microsoftTeams", tenantId: "t", teamId: "team", channelId: "c" })?.timestampMs,
    });
    const linear = parseFireTriggerEvent({ source: "linear", event: "statusChanged", issueIdentifier: "ENG-1", status: "Done", ignored: "dropped" });
    assert.deepEqual([linear?.["event"], linear?.["issueIdentifier"], linear?.["status"], "ignored" in (linear ?? {})], ["statusChanged", "ENG-1", "Done", false]);
    const sentry = parseFireTriggerEvent({ source: "sentry", event: "issueCreated", issueId: "1", shortId: "S-1", title: "boom" });
    assert.deepEqual([sentry?.["issueId"], sentry?.["shortId"], sentry?.["title"]], ["1", "S-1", "boom"]);
    const pagerduty = parseFireTriggerEvent({ source: "pagerduty", event: "incidentTriggered", incidentId: "1", title: "boom", status: "triggered", serviceId: "svc" });
    assert.deepEqual([pagerduty?.["incidentId"], pagerduty?.["status"], pagerduty?.["serviceId"]], ["1", "triggered", "svc"]);
  });

  it("refuses an event that is not one of the kinds, or is missing what it needs", () => {
    assert.equal(parseFireTriggerEvent(null), null);
    assert.equal(parseFireTriggerEvent("not an object"), null);
    assert.equal(parseFireTriggerEvent({ source: "somewhere else" }), null);
    assert.equal(parseFireTriggerEvent({ source: "slack" }), null);
    assert.equal(parseFireTriggerEvent({ source: "github", repo: "o/r" }), null);
    assert.equal(parseFireTriggerEvent({ source: "github", repo: "o/r", kind: "not-a-kind" }), null);
    assert.equal(parseFireTriggerEvent({ source: "microsoftTeams", tenantId: "t", teamId: "team" }), null);
    assert.equal(parseFireTriggerEvent({ source: "microsoftTeams", tenantId: "t", teamId: "team", channelId: "x".repeat(201) }), null);
    assert.equal(parseFireTriggerEvent({ source: "linear", event: "not-an-event" }), null);
    assert.equal(parseFireTriggerEvent({ source: "microsoftTeams", tenantId: "t", teamId: "team", channelId: "c", text: "x".repeat(4_001) }), null);
    // An optional field that is too long refuses the event rather than being quietly dropped.
    assert.equal(parseFireTriggerEvent({ source: "sentry", event: "issueCreated", issueId: "1", shortId: "S", title: "t", url: "u".repeat(601) }), null);
    assert.equal(parseFireTriggerEvent({ source: "sentry", event: "issueCreated", issueId: "1" }), null);
    assert.equal(parseFireTriggerEvent({ source: "pagerduty", event: "incidentTriggered", incidentId: "1", title: "t", status: "s" }), null);
    // A field that is too long to be what it claims to be refuses the whole event rather than being truncated.
    assert.equal(parseFireTriggerEvent({ source: "sentry", event: "issueCreated", issueId: "1", shortId: "S", title: "x".repeat(401) }), null);
  });
});

describe("which fire is admitted", () => {
  it("lets a bare fire through only when the schedule could have raised it", () => {
    assert.equal(admitsBareFire(cron("0 9 * * *"), {}), true);
    assert.equal(admitsBareFire(slack("C1", { kind: "mention" }), {}), false);
    assert.equal(admitsBareFire({ type: "group", listeners: [cron("0 9 * * *"), slack("C1", { kind: "mention" })] }, {}), false);
    assert.equal(admitsBareFire({ type: "group", listeners: [cron("0 9 * * *"), slack("C1", { kind: "mention" })] }, { scheduledForMs: 1 }), true);
  });

  it("matches an event against the trigger that listens for it", () => {
    assert.equal(fireEventMatchesTrigger(slack("C1", { kind: "mention" }), { source: "slack", channel: "C1", text: "hi", isMention: true }, { source: "slack", channelId: "C1" }), true);
    assert.equal(fireEventMatchesTrigger(slack("C1", { kind: "mention" }), { source: "slack", channel: "C1", text: "hi", isMention: false }, { source: "slack", channelId: "C1" }), false);
    assert.equal(fireEventMatchesTrigger(github("o/r", ["pr-opened"]), { source: "github", repo: "o/r", kind: "pr-opened" }, { source: "github", repo: "o/r", kind: "pr-opened" }), true);
    assert.equal(fireEventMatchesTrigger(github("o/r", ["pr-opened"]), { source: "github", repo: "o/r", kind: "pr-merged" }, {}), false);
    // The channel the platform names in the wire message can stand in when the event's own channel is another view of
    // the same conversation.
    assert.equal(fireEventMatchesTrigger(slack("C1", { kind: "mention" }), { source: "slack", channel: "C-other", text: "hi", isMention: true }, { source: "slack", channelId: "C1" }), true);
    assert.equal(fireEventMatchesTrigger(slack("C1", { kind: "mention" }), { source: "slack", channel: "C-other", text: "hi", isMention: true }, "not a record"), false);
  });

  it("says how a run ended, in the words the backend takes", () => {
    assert.deepEqual(completionOfOutcome("ok"), { phase: "completed", status: "succeeded" });
    const interrupted = completionOfOutcome("interrupted");
    assert.equal(interrupted.status, "failed");
    assert.match(String(interrupted.errorMessage), /interrupted by a Slate host update/);
    const failed = completionOfOutcome("error");
    assert.equal(failed.status, "failed");
    assert.match(String(failed.errorMessage), /failed on the Slate box/);
    assert.equal(ERROR_BACKOFF_MS, 30_000);
    assert.equal(MAX_NEXT_POLL_DELAY_MS, 60_000);
    assert.deepEqual(new BackendStatusError("/x", 500).status, 500);
    assert.match(new BackendStatusError("/x", 500).message, /slate automation relay \/x returned 500/);
  });
});

describe("polling for fires", () => {
  it("does not poll when it is stopped, when it is not ready, or while it is backing off", async () => {
    const stopped = world();
    stopped.consumer.stop();
    await stopped.consumer.tick();
    assert.equal(stopped.named("getAccessToken").length, 0);
    const notReady = world({ ready: false });
    await notReady.consumer.tick();
    assert.equal(notReady.named("getAccessToken").length, 0);
    // A backend that could not be reached is left alone until the backoff has passed.
    const failing = world({ pollStatus: 500 });
    await failing.consumer.tick();
    assert.equal(failing.backend.polls().length, 1);
    assert.equal((failing.errors[0]?.error as { code: string }).code, SlateError.backendHttpStatus().code);
    assert.equal(failing.errors[0]?.source, "automation_fire_poll");
    await failing.consumer.tick();
    assert.equal(failing.backend.polls().length, 1);
    // An unreachable backend and one that answered oddly are told apart.
    const unreachable = world({ failFetch: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
    await unreachable.consumer.tick();
    assert.deepEqual((unreachable.errors[0]?.error as { code: string; errno: string }).errno, "ECONNREFUSED");
    const odd = world({ failFetch: new Error("something else") });
    await odd.consumer.tick();
    assert.equal((odd.errors[0]?.error as { code: string }).code, SlateError.backendDeliveryFailed().code);
  });

  it("waits as long as the backend asked before polling again", async () => {
    const world1 = world({ polls: [{ events: [], nextPollAfterMs: 5_000 }] });
    await world1.consumer.tick();
    assert.equal(world1.backend.polls().length, 1);
    // Nothing is owed, so the backend's own delay is respected instead of being asked again at once.
    await world1.consumer.tick();
    assert.equal(world1.backend.polls().length, 1);
    // A delay longer than the platform allows is capped.
    const capped = world({ polls: [{ events: [], nextPollAfterMs: 10 * 60_000 }] });
    await capped.consumer.tick();
    assert.equal(capped.backend.polls().length, 1);
    await capped.consumer.tick();
    assert.equal(capped.backend.polls().length, 1);
    // Forgetting the delay lets it ask again.
    capped.consumer.resetPollDelay();
    await capped.consumer.tick();
    assert.equal(capped.backend.polls().length, 2);
  });

  it("fires what the backend raised, completes it, and acks it once it has been reported", async () => {
    const world1 = world({ polls: [{ events: [fireWire({ scheduledForMs: Date.now() - 500 })] }, { events: [] }] });
    await world1.consumer.tick();
    await settle();
    assert.equal(world1.named("fire").length, 1);
    const fired = world1.named("fire")[0]?.args[0] as { runUuid: string; scheduledForMs: number };
    assert.deepEqual([fired.runUuid, fired.scheduledForMs !== undefined], ["run-uuid-1", true]);
    assert.deepEqual(world1.backend.completes()[0]?.args[1], { runUuid: "run-uuid-1", status: "succeeded" });
    // The next poll tells the backend it can let go of the run it already answered for.
    await world1.consumer.tick();
    assert.deepEqual(world1.backend.polls()[1]?.args[1], { ackRunUuids: ["run-uuid-1"] });
    // An event with an event context is fired through the event path with the parsed event.
    const byEvent = world({
      polls: [{ events: [fireWire({ event: { source: "slack", channel: "C1", text: "hi", isMention: true } })] }],
      targets: [{ agentId: "agent-1", automation: automationOf({ trigger: slack("C1", { kind: "mention" }) }) }],
    });
    await byEvent.consumer.tick();
    await settle();
    assert.equal(byEvent.named("fireForEvent").length, 1);
    assert.deepEqual((byEvent.named("fireForEvent")[0]?.args[0] as { event: unknown }).event, { source: "slack", channel: "C1", sender: "someone", text: "hi", isMention: true, timestampMs: (byEvent.named("fireForEvent")[0]?.args[0] as { event: { timestampMs: number } }).event.timestampMs });
    assert.equal(byEvent.named("fire").length, 0);
  });

  it("answers from the run it already has instead of firing again", async () => {
    const id = "run-uuid-1";
    const succeeded = world({ polls: [{ events: [fireWire()] }], targets: [{ agentId: "agent-1", automation: automationOf() }] });
    (succeeded.consumer as unknown as { deps: { listAutomations: () => Promise<unknown[]> } }).deps.listAutomations = async () => [
      { agentId: "agent-1", automation: { ...automationOf(), runs: [{ id, status: "ok" }] } },
    ];
    await succeeded.consumer.tick();
    await settle();
    assert.equal(succeeded.named("fire").length, 0);
    assert.deepEqual(succeeded.backend.completes()[0]?.args[1], { runUuid: id, status: "succeeded" });
    // A run that coalesced this fire counts as the same run, and one that is still running is not an answer.
    const coalesced = world({ polls: [{ events: [fireWire()] }] });
    (coalesced.consumer as unknown as { deps: { listAutomations: () => Promise<unknown[]> } }).deps.listAutomations = async () => [
      { agentId: "agent-1", automation: { ...automationOf(), runs: [{ id: "another-run", coalescedRunIds: [id], status: "error", detail: "it broke" }] } },
    ];
    await coalesced.consumer.tick();
    await settle();
    assert.equal(coalesced.named("fire").length, 0);
    assert.deepEqual(coalesced.backend.completes()[0]?.args[1], { runUuid: id, status: "failed", errorMessage: "it broke" });
    const running = world({ polls: [{ events: [fireWire()] }] });
    (running.consumer as unknown as { deps: { listAutomations: () => Promise<unknown[]> } }).deps.listAutomations = async () => [
      { agentId: "agent-1", automation: { ...automationOf(), runs: [{ id, status: "running" }] } },
    ];
    await running.consumer.tick();
    await settle();
    assert.equal(running.named("fire").length, 1);
  });

  it("reports a fire it will not run, once, with what the platform knew about it", async () => {
    const missing = world({ polls: [{ events: [fireWire()] }], targets: [] });
    await missing.consumer.tick();
    await settle();
    assert.deepEqual(missing.dropped[0]?.reason, "automation_missing");
    assert.deepEqual(missing.backend.completes()[0]?.args[1], { runUuid: "run-uuid-1", status: "failed", errorMessage: "Automation not found on the Slate box" });
    const disabled = world({ polls: [{ events: [fireWire()] }], targets: [{ agentId: "agent-1", automation: automationOf({ isEnabled: false }) }] });
    await disabled.consumer.tick();
    await settle();
    assert.deepEqual(disabled.dropped[0]?.reason, "automation_disabled");
    // A legacy fire whose slot the automation has already run is covered rather than run again.
    const covered = world({ polls: [{ events: [fireWire()] }], targets: [{ agentId: "agent-1", automation: { ...automationOf(), lastRunAt: Date.now() } } as never] });
    await covered.consumer.tick();
    await settle();
    assert.deepEqual(covered.dropped[0]?.reason, "slot_already_covered");
    // A definition that changed under the fire is refused.
    const changed = world({ polls: [{ events: [fireWire({ definitionRevision: "not-the-hash" })] }] });
    await changed.consumer.tick();
    await settle();
    assert.deepEqual(changed.dropped[0]?.reason, "definition_changed");
    // The revision the platform has is the one this consumer computes.
    const matching = world({ polls: [{ events: [fireWire({ definitionRevision: slateCloudDefinition({ agentId: "agent-1", automation: automationOf() })?.hash })] }] });
    await matching.consumer.tick();
    await settle();
    assert.equal(matching.named("fire").length, 1);
    assert.equal(matching.dropped.length, 0);
    // An event nobody can read, and one the trigger no longer listens for.
    const unreadable = world({ polls: [{ events: [fireWire({ event: { source: "nowhere" } })] }] });
    await unreadable.consumer.tick();
    await settle();
    assert.deepEqual(unreadable.dropped[0]?.reason, "event_unrecognized");
    const unmatched = world({ polls: [{ events: [fireWire({ event: { source: "slack", channel: "C-other", isMention: true } })] }], targets: [{ agentId: "agent-1", automation: automationOf({ trigger: slack("C1", { kind: "mention" }) }) }] });
    await unmatched.consumer.tick();
    await settle();
    assert.deepEqual(unmatched.dropped[0]?.reason, "trigger_no_longer_matches");
    // A fire that carried no event context cannot be admitted by a trigger that also listens for events.
    const noContext = world({ polls: [{ events: [fireWire()] }], targets: [{ agentId: "agent-1", automation: automationOf({ trigger: { type: "group", listeners: [cron("0 9 * * *"), slack("C1", { kind: "mention" })] } }) }] });
    await noContext.consumer.tick();
    await settle();
    assert.deepEqual(noContext.dropped[0]?.reason, "missing_event_context");
    assert.deepEqual(noContext.dropped[0]?.trigger, "event");
    // What the report carries about the moment it arrived.
    const detail = world({ polls: [{ events: [fireWire({ scheduledForMs: Date.now() - 1_000 })] }], targets: [], boxUptimeMs: 4_000 });
    await detail.consumer.tick();
    await settle();
    assert.deepEqual(
      [detail.dropped[0]?.conversationId, detail.dropped[0]?.trigger, detail.dropped[0]?.runUuid, detail.dropped[0]?.boxUptimeMs, typeof detail.dropped[0]?.latenessMs, typeof detail.dropped[0]?.fireAgeMs, detail.dropped[0]?.hasDefinitionRevision],
      ["agent-1", "schedule", "run-uuid-1", 4_000, "number", "number", false],
    );
  });

  it("gives up on a fire it could not deliver, and keeps trying one it could not complete", async () => {
    // A fire that throws while being delivered is reported as a delivery error and not retried.
    const throwing = world({ polls: [{ events: [fireWire()] }] });
    (throwing.consumer as unknown as { deps: { fire: () => Promise<string> } }).deps.fire = async () => {
      throw Object.assign(new Error("box is gone"), { code: "EHOSTUNREACH" });
    };
    await throwing.consumer.tick();
    await settle();
    assert.deepEqual([throwing.dropped[0]?.reason, throwing.dropped[0]?.errorType, throwing.dropped[0]?.errorCode], ["delivery_error", "Error", "EHOSTUNREACH"]);
    assert.equal(throwing.backend.completes().length, 0);
    // A completion the backend could not take is tried again on the next poll; one it refuses as already known is not.
    const retried = world({ polls: [{ events: [fireWire()] }, { events: [fireWire()] }], completeStatus: 503 });
    await retried.consumer.tick();
    await settle();
    assert.equal(retried.backend.completes().length, 1);
    await retried.consumer.tick();
    await settle();
    assert.equal(retried.backend.completes().length, 2);
    const alreadyKnown = world({ polls: [{ events: [fireWire()] }, { events: [fireWire()] }], completeStatus: 409 });
    await alreadyKnown.consumer.tick();
    await settle();
    await alreadyKnown.consumer.tick();
    await settle();
    assert.equal(alreadyKnown.backend.completes().length, 1);
    // A fire the box declined to run at all is not completed, because the box owns it now.
    const declined = world({ polls: [{ events: [fireWire()] }], declinesFire: true });
    await declined.consumer.tick();
    await settle();
    assert.equal(declined.backend.completes().length, 0);
    assert.equal(declined.dropped.length, 0);
    const declinedEvent = world({ polls: [{ events: [fireWire({ event: { source: "slack", channel: "C1", isMention: true } })] }], targets: [{ agentId: "agent-1", automation: automationOf({ trigger: slack("C1", { kind: "mention" }) }) }], declinesFire: true });
    await declinedEvent.consumer.tick();
    await settle();
    assert.deepEqual([declinedEvent.backend.completes().length, declinedEvent.dropped.length], [0, 0]);
    // And what a fire finished as is reported with the fire it belonged to.
    const reported = world({ polls: [{ events: [fireWire()] }], targets: [] });
    await reported.consumer.tick();
    await settle();
    assert.deepEqual(reported.dropped[0]?.runUuid, "run-uuid-1");
    // An aborted run is reported as failed with what happened to it.
    const interrupted = world({ polls: [{ events: [fireWire()] }], fireOutcome: "interrupted" });
    await interrupted.consumer.tick();
    await settle();
    assert.match(String((interrupted.backend.completes()[0]?.args[1] as { errorMessage: string }).errorMessage), /interrupted by a Slate host update/);
  });

  it("forgets a fire the backend no longer raises, and lets its own memory of refusals go", async () => {
    // A run that was reported and is not raised again is dropped from the state, so a later fire for the same id is
    // delivered rather than ignored.
    const world1 = world({ polls: [{ events: [fireWire()] }, { events: [] }, { events: [fireWire()] }] });
    await world1.consumer.tick();
    await settle();
    await world1.consumer.tick();
    await settle();
    world1.consumer.stop();
    await world1.consumer.tick();
    world1.consumer.start();
    await world1.consumer.tick();
    await settle();
    assert.equal(world1.named("fire").length, 2);
    // The memory of what was refused is bounded, so a very old refusal does not stop a fresh report of the same id.
    const bounded = world({ targets: [] });
    const reject = (bounded.consumer as unknown as { reject: (event: unknown, reason: string, message: string) => void }).reject.bind(bounded.consumer);
    // The same fire, refused twice, is reported once.
    reject(fireWire({ id: "run-dup" }), "automation_missing", "no");
    reject(fireWire({ id: "run-dup" }), "automation_missing", "no");
    assert.equal(bounded.dropped.filter((report) => report.runUuid === "run-dup").length, 1);
    for (let index = 0; index < 300; index += 1) reject(fireWire({ id: `run-${index}` }), "automation_missing", "no");
    reject(fireWire({ id: "run-0" }), "automation_missing", "no");
    assert.equal(bounded.dropped.filter((report) => report.runUuid === "run-0").length, 2);
    // Starting again clears what the gate remembered.
    bounded.consumer.start();
    bounded.consumer.stop();
  });

  it("only asks the backend when the notification link says it should", async () => {
    const connected = world({ notifyConnected: true });
    await connected.consumer.tick();
    assert.equal(connected.backend.polls().length, 1);
    // With the link up and nothing recorded since the last poll, the next poll is left to the safety interval.
    await connected.consumer.tick();
    assert.equal(connected.backend.polls().length, 1);
    // Asking to drain does not ask the backend before the floor has passed either.
    connected.consumer.requestDrain();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(connected.backend.polls().length, 1);
    // A link that is down drains on its own.
    const down = world({ notifyConnected: false });
    await down.consumer.tick();
    assert.equal(down.backend.polls().length, 1);
  });
});
