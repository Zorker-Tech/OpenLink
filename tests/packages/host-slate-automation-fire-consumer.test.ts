import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BackendStatusError,
  ERROR_BACKOFF_MS,
  MAX_REPORTED_REJECTED_FIRES,
  SlateAutomationFireConsumer,
  admitsBareFire,
  completionOfOutcome,
  fireEventMatchesTrigger,
  parseFireTriggerEvent,
} from "../../source/host/automations/slate-automation-fire-consumer.ts";
import { GITHUB_EVENT_KINDS } from "../../source/shared/automations.ts";
import { stableAutomationId } from "../../source/host/automations/automation-id.ts";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const automation = (overrides: Record<string, unknown> = {}) => ({
  id: "automation-1",
  name: "Nightly",
  isEnabled: true,
  trigger: { type: "cron", schedule: "0 0 * * *" },
  lastRunAt: undefined,
  runs: [],
  ...overrides,
});
const fire = (overrides: Record<string, unknown> = {}) => ({
  id: "run-1",
  slateAgentId: "agent-1",
  automationId: stableAutomationId({ agentId: "agent-1", localId: "automation-1" }),
  timestampMs: 5000,
  ...overrides,
});
function fakeBackend(handlers: { poll?: (body: unknown) => unknown; complete?: (body: unknown) => unknown; statusFor?: (path: string) => number }) {
  const calls: Array<{ path: string; body: unknown; headers: Record<string, string> }> = [];
  const fetchImpl = async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    calls.push({ path, body, headers: init.headers });
    if (path === "/slate/automation-events/poll") return { ok: true, status: 200, async json() { return handlers.poll?.(body) ?? {}; } };
    if (path === "/slate/automation-runs/complete") { const status = handlers.statusFor?.(path) ?? 200; return { ok: status < 400, status, async json() { return handlers.complete?.(body) ?? {}; } }; }
    const status = handlers.statusFor?.(path) ?? 200;
    return { ok: status < 400, status, async json() { return {}; } };
  };
  return { calls, fetchImpl };
}
function makeConsumer(options: {
  automations?: unknown[];
  fire?: (args: any) => Promise<string | undefined>;
  fireForEvent?: (args: any) => Promise<string | undefined>;
  backend?: ReturnType<typeof fakeBackend>;
  ready?: boolean;
  telemetry?: Record<string, unknown>;
} = {}) {
  const backend = options.backend ?? fakeBackend({});
  const telemetry: Record<string, unknown> = options.telemetry ?? { reportAutomationFireDropped: () => {}, reportAgentError: () => {} };
  const calls = { fire: [] as any[], fireForEvent: [] as any[], dropped: [] as any[], errors: [] as any[] };
  telemetry.reportAutomationFireDropped = (value: unknown) => calls.dropped.push(value);
  telemetry.reportAgentError = (value: unknown) => calls.errors.push(value);
  const consumer = new SlateAutomationFireConsumer({
    getAccessToken: async () => "token",
    getBackendUrl: () => "https://backend.example",
    getTimeZone: () => "UTC",
    getBoxUptimeMs: () => 1234,
    isReady: async () => options.ready ?? true,
    listAutomations: async () => (options.automations ?? [{ agentId: "agent-1", automation: automation() }]) as never,
    fire: async (args: any) => { calls.fire.push(args); return (options.fire ?? (async () => "ok"))(args); },
    fireForEvent: async (args: any) => { calls.fireForEvent.push(args); return (options.fireForEvent ?? (async () => "ok"))(args); },
    fetchImpl: backend.fetchImpl as never,
    telemetry: telemetry as never,
    isNotifyConnected: () => true,
    isNotifySafetyPollEnabled: () => false,
  } as never);
  return { consumer, backend, calls };
}

test("a slack fire context is normalized with its optional fields", () => {
  assert.deepEqual(parseFireTriggerEvent({ source: "slack", channel: "C1", sender: "S", text: "hi", isMention: true, isSelf: true, reactionEmoji: "eyes", ts: "1", threadTs: "0", timestampMs: 7 }), { source: "slack", channel: "C1", sender: "S", text: "hi", isMention: true, isSelf: true, reactionEmoji: "eyes", ts: "1", threadTs: "0", timestampMs: 7 });
  const minimal = parseFireTriggerEvent({ source: "slack", channel: "C1" });
  assert.equal(minimal?.sender, "someone");
  assert.equal(minimal?.text, "");
  assert.equal(minimal?.isMention, false);
  assert.equal(parseFireTriggerEvent({ source: "slack" }), null);
  assert.equal(parseFireTriggerEvent(null), null);
  assert.equal(parseFireTriggerEvent([]), null);
});

test("a github fire context requires a repo and a known kind", () => {
  assert.deepEqual(parseFireTriggerEvent({ source: "github", repo: "r", kind: GITHUB_KIND(), title: "t", actor: "a", url: "u", detail: "d", prOwner: "p", branch: "b" }), { source: "github", repo: "r", kind: GITHUB_KIND(), title: "t", actor: "a", url: "u", detail: "d", prOwner: "p", branch: "b", timestampMs: Date.now() });
  assert.equal(parseFireTriggerEvent({ source: "github", repo: "", kind: GITHUB_KIND() }), null);
  assert.equal(parseFireTriggerEvent({ source: "github", repo: "r", kind: "unknown-kind" }), null);
});

test("teams, linear, sentry and pagerduty contexts keep only their known fields", () => {
  const teams = parseFireTriggerEvent({ source: "microsoftTeams", tenantId: "t", teamId: "team", channelId: "c", text: "x", aadObjectId: "a", activityId: "act", rootMessageId: "root", timestampMs: 9 });
  assert.deepEqual(teams, { source: "microsoftTeams", tenantId: "t", teamId: "team", channelId: "c", text: "x", aadObjectId: "a", activityId: "act", rootMessageId: "root", timestampMs: 9 });
  assert.equal(parseFireTriggerEvent({ source: "microsoftTeams", tenantId: "t", teamId: "", channelId: "c" }), null);
  const linear = parseFireTriggerEvent({ source: "linear", event: "issueCreated", issueIdentifier: "ENG-1", title: "T", url: "u", status: "todo", projectId: "p", teamId: "t", statusId: "s", cycleId: "c", cycleName: "n", ignored: "x", timestampMs: 3 });
  assert.deepEqual(linear, { source: "linear", event: "issueCreated", timestampMs: 3, issueIdentifier: "ENG-1", title: "T", url: "u", status: "todo", projectId: "p", teamId: "t", statusId: "s", cycleId: "c", cycleName: "n" });
  assert.equal(parseFireTriggerEvent({ source: "linear", event: "bad", issueIdentifier: "x" }), null);
  assert.equal(parseFireTriggerEvent({ source: "sentry", event: "issueCreated", issueId: "i", shortId: "s", title: "T" })?.shortId, "s");
  assert.equal(parseFireTriggerEvent({ source: "sentry", event: "bad", issueId: "i", shortId: "s", title: "T" }), null);
  assert.equal(parseFireTriggerEvent({ source: "pagerduty", event: "incidentTriggered", incidentId: "i", title: "T", status: "s", serviceId: "svc" })?.serviceId, "svc");
  assert.equal(parseFireTriggerEvent({ source: "pagerduty", event: "incidentTriggered", incidentId: "i" }), null);
  assert.equal(parseFireTriggerEvent({ source: "unknown" }), null);
});

function GITHUB_KIND(): string {
  // One of the platform's github kinds, read from the shared list.
  return GITHUB_EVENT_KINDS[0]!;
}

test("a bare fire is admitted only for a cron trigger without required events", () => {
  const schedule = { type: "cron", schedule: "0 0 * * *" } as never;
  assert.equal(admitsBareFire(schedule, {}), true);
  assert.equal(admitsBareFire(schedule, { scheduledForMs: 5 }), true);
  const events = { type: "slack", channel: "C1", match: { kind: "mention" } } as never;
  assert.equal(admitsBareFire(events, {}), false);
  assert.equal(admitsBareFire(events, { scheduledForMs: 5 }), false);
});

test("a fire event matches its trigger, including the slack channel rewrite", () => {
  const trigger = { type: "slack", channel: "C1", match: { kind: "mention" } } as never;
  const parsed = { source: "slack", channel: "C9", sender: "S", text: "hi", isMention: true } as never;
  assert.equal(fireEventMatchesTrigger(trigger, parsed, { channelId: "C1" }), true);
  assert.equal(fireEventMatchesTrigger(trigger, { source: "slack", channel: "C2", sender: "S", text: "hi", isMention: false } as never, undefined), false);
});

test("an outcome becomes a completion", () => {
  assert.deepEqual(completionOfOutcome("ok"), { phase: "completed", status: "succeeded" });
  assert.deepEqual(completionOfOutcome("failed"), { phase: "completed", status: "failed", errorMessage: "Automation run failed on the Slate box" });
  assert.match(completionOfOutcome("interrupted").errorMessage ?? "", /interrupted by a Slate host update/);
  assert.equal(new BackendStatusError("/x", 500).message, "slate automation relay /x returned 500");
});

test("a poll delivers fires and reports the completion", async () => {
  const backend = fakeBackend({ poll: () => ({ events: [fire({ definitionRevision: undefined, event: undefined })], nextPollAfterMs: 0 }) });
  const { consumer, calls } = makeConsumer({ backend });
  await consumer.tick(); await tick(50);
  assert.equal(calls.fire.length, 1);
  assert.deepEqual({ runUuid: calls.fire[0]!.runUuid, agentId: calls.fire[0]!.agentId }, { runUuid: "run-1", agentId: "agent-1" });
  const completes = backend.calls.filter((call) => call.path === "/slate/automation-runs/complete");
  assert.deepEqual(completes.map((call) => call.body), [{ runUuid: "run-1", status: "succeeded" }]);
  assert.equal(backend.calls[0]!.headers.authorization, "Bearer token");
});

test("a fire for an automation the box no longer has is rejected and reported once", async () => {
  const backend = fakeBackend({ poll: () => ({ events: [fire()] }) });
  const { consumer, calls } = makeConsumer({ backend, automations: [] });
  await consumer.tick(); await tick(50);
  assert.equal(calls.dropped.length, 1);
  assert.equal(calls.dropped[0]!?.reason, "automation_missing");
  assert.deepEqual(calls.dropped[0]!.trigger, "schedule");
  assert.equal(calls.dropped[0]!.conversationId, "agent-1");
  assert.equal(calls.dropped[0]!.boxUptimeMs, 1234);
  assert.match((backend.calls.find((call) => call.path === "/slate/automation-runs/complete")?.body as { errorMessage: string }).errorMessage, /Automation not found on the Slate box/);
});

test("disabled, changed-definition and bad-event fires are all refused", async () => {
  const disabled = makeConsumer({ automations: [{ agentId: "agent-1", automation: automation({ isEnabled: false }) }], backend: fakeBackend({ poll: () => ({ events: [fire()] }) }) });
  await disabled.consumer.tick();
  assert.equal(disabled.calls.dropped[0]!.reason, "automation_disabled");
  const changed = makeConsumer({ backend: fakeBackend({ poll: () => ({ events: [fire({ definitionRevision: "stale" })] }) }) });
  await changed.consumer.tick();
  assert.equal(changed.calls.dropped[0]!.reason, "definition_changed");
  const badEvent = makeConsumer({ backend: fakeBackend({ poll: () => ({ events: [fire({ event: { source: "unknown" } })] }) }) });
  await badEvent.consumer.tick();
  assert.equal(badEvent.calls.dropped[0]!.reason, "event_unrecognized");
});

test("a delivered event fire goes through fireForEvent and a legacy fire through fire", async () => {
  const eventFire = fire({ event: { source: "slack", channel: "C1", isMention: true } });
  const world = makeConsumer({ automations: [{ agentId: "agent-1", automation: automation({ trigger: { type: "slack", channel: "C1", match: { kind: "mention" } } }) }], backend: fakeBackend({ poll: () => ({ events: [eventFire] }) }) });
  await world.consumer.tick(); await tick(50);
  assert.equal(world.calls.fireForEvent.length, 1);
  assert.equal(world.calls.fire.length, 0);
  const legacy = makeConsumer({ backend: fakeBackend({ poll: () => ({ events: [fire({ scheduledForMs: 100 })] }) }) });
  await legacy.consumer.tick(); await tick(50);
  assert.deepEqual({ scheduled: legacy.calls.fire[0]!!.scheduledForMs, runUuid: legacy.calls.fire[0]!!.runUuid }, { scheduled: 100, runUuid: "run-1" });
});

test("an existing run is answered without firing again", async () => {
  const world = makeConsumer({ automations: [{ agentId: "agent-1", automation: automation({ runs: [{ id: "run-1", status: "ok" }] }) }], backend: fakeBackend({ poll: () => ({ events: [fire({ runUuid: "run-1" })] }) }) });
  await world.consumer.tick(); await tick(50);
  assert.equal(world.calls.fire.length, 0);
  assert.equal((world.backend.calls.find((call) => call.path === "/slate/automation-runs/complete")!.body as { status: string }).status, "succeeded");
});

test("a poll failure backs off and reports the delivery error", async () => {
  const backend = fakeBackend({ poll: () => { throw new BackendStatusError("/slate/automation-events/poll", 503); } });
  const { consumer, calls } = makeConsumer({ backend });
  await consumer.tick(); await tick(50);
  assert.equal(calls.errors.length, 1);
  assert.equal(calls.errors[0]!.source, "automation_fire_poll");
  await consumer.tick(); await tick(50);
  assert.equal(calls.errors.length, 1);
  assert.equal(ERROR_BACKOFF_MS, 30_000);
});

test("a next poll delay bounds the poll window", async () => {
  const backend = fakeBackend({ poll: () => ({ nextPollAfterMs: 5_000 }) });
  const { consumer } = makeConsumer({ backend });
  await consumer.tick(); await tick(50);
  assert.equal(backend.calls.filter((call) => call.path === "/slate/automation-events/poll").length, 1);
});

test("the rejected-fire report is deduped", async () => {
  const world = makeConsumer({ automations: [] });
  await (world.consumer as any).deliverFire(fire({ id: "run-0" }));
  await (world.consumer as any).deliverFire(fire({ id: "run-0" }));
  assert.equal(world.calls.dropped.length, 1);
  assert.equal(world.calls.dropped[0]!.reason, "automation_missing");
  assert.equal(MAX_REPORTED_REJECTED_FIRES, 256);
});
test("teams, sentry and pagerduty defaults are filled or refused", () => {
  const teams = parseFireTriggerEvent({ source: "microsoftTeams", tenantId: "t", teamId: "team", channelId: "c" });
  assert.equal(teams?.aadObjectId, "unknown");
  assert.equal(teams?.activityId, "unknown");
  assert.equal(parseFireTriggerEvent({ source: "sentry", event: "issueCreated", issueId: "i", shortId: "s" }), null);
  assert.equal(parseFireTriggerEvent({ source: "pagerduty", event: "incidentTriggered", incidentId: "i", title: "T", status: "s" }), null);
});

test("a stopped consumer does not poll or deliver", async () => {
  const backend = fakeBackend({ poll: () => ({ events: [fire()] }) });
  const world = makeConsumer({ automations: [], backend });
  world.consumer.start();
  world.consumer.stop();
  await world.consumer.tick();
  assert.equal(backend.calls.length, 0);
  (world.consumer as any).runStates.set("run-1", { phase: "running" });
  await (world.consumer as any).deliverFire(fire());
  assert.equal(world.calls.fire.length, 0);
  assert.equal((world.consumer as any).runStates.has("run-1"), false);
});

test("reported runs are acknowledged on the next poll", async () => {
  const backend = fakeBackend({ poll: () => ({ events: [fire()] }) });
  const world = makeConsumer({ backend });
  await world.consumer.tick();
  await tick(50);
  (world.consumer as any).runStates.set("other-run", { phase: "completed" });
  await world.consumer.tick();
  await tick(50);
  const polls = backend.calls.filter((call) => call.path === "/slate/automation-events/poll");
  assert.deepEqual(polls[1]?.body, { ackRunUuids: ["run-1"] });
});

test("a delayed next poll is respected before polling again", async () => {
  const backend = fakeBackend({ poll: () => ({ nextPollAfterMs: 60_000 }) });
  const world = makeConsumer({ backend });
  (world.consumer as any).drainGate = { shouldDrain: () => true, recordPoll() {}, recordNotify() {}, reset() {} };
  await world.consumer.tick();
  const first = backend.calls.length;
  await world.consumer.tick();
  assert.equal(backend.calls.length, first);
  world.consumer.resetPollDelay();
  await world.consumer.tick();
  assert.equal(backend.calls.length > first, true);
});

test("a legacy fire without its event context is refused", async () => {
  const world = makeConsumer({ automations: [{ agentId: "agent-1", automation: automation({ trigger: { type: "slack", channel: "C1", match: { kind: "mention" } } }) }], backend: fakeBackend({ poll: () => ({ events: [fire()] }) }) });
  await world.consumer.tick();
  await tick(50);
  assert.equal(world.calls.dropped[0]?.reason, "missing_event_context");
  assert.equal(world.calls.dropped[0]?.trigger, "event");
});

test("the rejected-fire set is bounded, so an old fire can be reported again", async () => {
  const world = makeConsumer({ automations: [] });
  for (let index = 0; index < MAX_REPORTED_REJECTED_FIRES + 2; index += 1) await (world.consumer as any).deliverFire(fire({ id: "run-" + index }));
  const before = world.calls.dropped.length;
  await (world.consumer as any).deliverFire(fire({ id: "run-0" }));
  assert.equal(world.calls.dropped.length, before + 1);
});

test("a completed run whose report lost a race is still reported", async () => {
  const backend = fakeBackend({ statusFor: (path) => (path === "/slate/automation-runs/complete" ? 409 : 200) });
  const world = makeConsumer({ backend });
  await (world.consumer as any).reportCompletion("run-1", { phase: "completed", status: "succeeded" });
  assert.deepEqual((world.consumer as any).runStates.get("run-1"), { phase: "reported" });
});
