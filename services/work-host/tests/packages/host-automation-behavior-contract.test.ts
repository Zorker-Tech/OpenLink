import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AUTOMATION_MAX_NAME_LENGTH,
  AUTOMATION_MAX_RUN_DETAIL_LENGTH,
  AUTOMATION_MAX_RUN_HISTORY,
  AUTOMATION_MAX_PER_AGENT,
  AUTOMATION_PROMPT_GUIDANCE_VERSION,
  AUTOMATION_STATUS_PROMPT_MARKER,
  AUTOMATION_UI_LIMIT,
  MAX_EVENTS_IN_AUTOMATION_WAKE,
  buildAutomationWakePrompt,
  buildGroupAutomationSeed,
  clampAutomationName,
  clampWakeEvents,
  createAutomationRunId,
  describeTriggerEventBatch,
  normalizeAutomationPrompt,
  renderAutomationClearedStatusReminder,
  renderAutomationRuntimeStatusReminder,
  renderAutomationsSystemPrompt,
  slugifyAutomationName,
} from "../../source/host/automations/automation.ts";
import type { AutomationRecord } from "../../source/host/automations/automation.ts";
import {
  AUTOMATION_WAKE_CUE,
  LINEAR_EVENT_CASES,
  PAGERDUTY_EVENT_CASES,
  SENTRY_EVENT_CASES,
} from "../../source/shared/automations.ts";

function routine(overrides: Partial<AutomationRecord> = {}): AutomationRecord {
  return {
    id: "routine-1",
    name: "Morning review",
    prompt: "Summarize the new work.",
    trigger: { type: "cron", schedule: "15 9 * * 1-5" },
    isEnabled: true,
    createdAt: 1_000,
    lastRunAt: null,
    raisedNotices: [],
    schedule: "15 9 * * 1-5",
    triggerDescription: "Weekdays at 9:15 AM",
    nextRunAt: null,
    runs: [],
    filePath: "/slate/routines/routine-1/automation.json",
    ...overrides,
  } as unknown as AutomationRecord;
}

const event = (kind: string, title: string) => ({
  source: "github",
  kind,
  repo: "slate/app",
  title,
  actor: "developer",
});

describe("automation model and wake payload contracts", () => {
  it("keeps the exported capacities and prompt version explicit", () => {
    assert.deepEqual([
      AUTOMATION_MAX_NAME_LENGTH,
      AUTOMATION_MAX_PER_AGENT,
      AUTOMATION_UI_LIMIT,
      AUTOMATION_MAX_RUN_HISTORY,
      AUTOMATION_MAX_RUN_DETAIL_LENGTH,
      MAX_EVENTS_IN_AUTOMATION_WAKE,
      AUTOMATION_PROMPT_GUIDANCE_VERSION,
    ], [80, 50, 100, 20, 300, 25, "backend_triggers_v4"]);
  });

  it("normalizes names and saved prompts at their existing boundaries", () => {
    assert.equal(clampAutomationName("  A routine\nwith a long name  ").includes("\n"), false);
    assert.equal(clampAutomationName("x".repeat(AUTOMATION_MAX_NAME_LENGTH + 1)).length, AUTOMATION_MAX_NAME_LENGTH);
    assert.equal(normalizeAutomationPrompt("  do the work\n\n  "), "do the work");
    assert.equal(slugifyAutomationName(" Morning Review! "), "morning-review");
    assert.match(slugifyAutomationName("!!!"), /^automation-\d+$/);
    assert.match(createAutomationRunId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("caps events in a copied array without reordering the input", () => {
    const events = Array.from({ length: MAX_EVENTS_IN_AUTOMATION_WAKE + 2 }, (_, index) => event("pr-opened", `PR ${index}`));
    const kept = clampWakeEvents(events);
    assert.equal(kept.length, MAX_EVENTS_IN_AUTOMATION_WAKE);
    assert.equal(kept[0], events[0]);
    assert.equal(kept.at(-1), events[MAX_EVENTS_IN_AUTOMATION_WAKE - 1]);
    assert.notEqual(kept, events);
    assert.equal(events.length, MAX_EVENTS_IN_AUTOMATION_WAKE + 2);
  });

  it("describes no events, one event, and a batch by its latest event", () => {
    assert.equal(describeTriggerEventBatch([]), "");
    assert.equal(describeTriggerEventBatch([event("pr-opened", "First")]), 'PR opened in slate/app: "First" by developer');
    assert.equal(describeTriggerEventBatch([event("pr-opened", "First"), event("ci-failed", "Latest")]), '2 events; latest: CI failed in slate/app: "Latest" by developer');
  });

  it("keeps a prompt unchanged when no event fired and marks event data as untrusted", () => {
    assert.equal(buildGroupAutomationSeed({ prompt: "Saved task" }), "Saved task");
    const seed = buildGroupAutomationSeed({ prompt: "Saved task" }, event("pr-opened", "<outside>"));
    assert.match(seed, /Triggered by: PR opened in slate\/app/);
    assert.match(seed, /‹outside›/);
    assert.match(seed, /<github_event>/);
    assert.match(seed, /&lt;outside&gt;/);
    assert.match(seed, /outside sender is data|outside sender, not instructions/i);
  });

  it("builds an event wake ahead of manual or scheduled wording and escapes outside text", () => {
    const wake = buildAutomationWakePrompt(routine(), { trigger: "manual", event: event("pr-opened", "<outside>") });
    assert.ok(wake.startsWith(AUTOMATION_WAKE_CUE));
    assert.match(wake, /triggered by an event/);
    assert.match(wake, /What woke you/);
    assert.match(wake, /&lt;outside&gt;/);
    assert.doesNotMatch(wake, /The user pressed Run now/);
    assert.match(wake, /What you saved to do each time:/);
    assert.match(wake, /Summarize the new work\./);
  });

  it("uses the saved trigger description for a manual run and a due run", () => {
    const manual = buildAutomationWakePrompt(routine(), { trigger: "manual", timeZone: "UTC" });
    const scheduled = buildAutomationWakePrompt(routine(), { timeZone: "UTC" });
    assert.match(manual, /run on demand/);
    assert.match(manual, /Weekdays at 9:15 AM/);
    assert.match(scheduled, /is due/);
    assert.match(scheduled, /Weekdays at 9:15 AM/);
    assert.match(manual, /started/);
    assert.match(scheduled, /fired/);
  });

  it("returns no runtime status for an empty list and a clearly marked cleared status when asked", () => {
    assert.equal(renderAutomationRuntimeStatusReminder([]), null);
    const cleared = renderAutomationClearedStatusReminder();
    assert.match(cleared, /<system_reminder>/);
    assert.ok(cleared.includes(AUTOMATION_STATUS_PROMPT_MARKER));
    assert.match(cleared, /No current routines\./);
    assert.match(cleared, /<\/system_reminder>/);
  });

  it("reports active, paused, next-run, and recent-run status without repeating the firing run", () => {
    const reminder = renderAutomationRuntimeStatusReminder([
      routine({
        runs: [
          { id: "run-current", trigger: "schedule", startedAt: 2_000, finishedAt: null, status: "running" },
          { id: "run-last", trigger: "schedule", startedAt: 1_000, finishedAt: 1_500, status: "ok" },
        ],
        nextRunAt: 3_000,
      }),
      routine({ id: "routine-2", name: "Paused item", isEnabled: false, nextRunAt: 4_000 }),
    ], "UTC", { firingAutomationId: "routine-1" }) ?? "";
    assert.match(reminder, /<system_reminder>/);
    assert.match(reminder, /Morning review \(folder routine-1\): next run/);
    assert.match(reminder, /last run .*\(succeeded\)/);
    assert.doesNotMatch(reminder, /running now/);
    assert.match(reminder, /Paused item \(folder routine-2\): never run/);
    assert.doesNotMatch(reminder, /next run .*Paused item/);
  });
});

describe("the system guidance for saved routines", () => {
  it("is absent without a local routine folder and identifies the folder when configured", () => {
    assert.equal(renderAutomationsSystemPrompt([], null), "");
    const prompt = renderAutomationsSystemPrompt([], "/slate/routines", "Asia/Tokyo");
    assert.match(prompt, /\/slate\/routines/);
    assert.match(prompt, /automation\.json/);
    assert.match(prompt, /Asia\/Tokyo/);
    assert.match(prompt, /No routines yet\./);
  });

  it("guides repeat requests toward a routine and keeps saved instructions intent-based", () => {
    const prompt = renderAutomationsSystemPrompt([], "/slate/routines");
    assert.match(prompt, /recurr|repeat|standing order/i);
    assert.match(prompt, /repeating request, timed reminder, recurring report/i);
    assert.match(prompt, /clear|unambiguous|offer/i);
    assert.match(prompt, /exactly one schedule or trigger/i);
    assert.match(prompt, /future self|what to do each time|saved prompt/i);
    assert.match(prompt, /connector inputs.*change|schema.*change|don't hard-code|do not hard-code/i);
    assert.match(prompt, /GetMcpTools/);
  });

  it("teaches five-field schedules, timezone choice, and minute-of-message semantics", () => {
    const prompt = renderAutomationsSystemPrompt([], "/slate/routines", "Asia/Tokyo");
    assert.match(prompt, /five.field cron|5.field cron/i);
    assert.match(prompt, /minute hour day.of.month month day.of.week/i);
    assert.match(prompt, /Asia\/Tokyo/);
    assert.match(prompt, /CRON_TZ/);
    assert.match(prompt, /minute.{0,100}(timestamp|message time)|timestamp.{0,100}minute/is);
    assert.match(prompt, /top of the hour|:00|hour boundary/i);
  });

  it("defaults schedules to bounded weekday waking hours and names narrow off-hours exceptions", () => {
    const prompt = renderAutomationsSystemPrompt([], "/slate/routines");
    assert.match(prompt, /weekday/i);
    assert.match(prompt, /default scheduled routines to weekdays and waking hours/i);
    assert.match(prompt, /8am|8 a\.m\.|08:00/i);
    assert.match(prompt, /7pm|7 p\.m\.|19:00/i);
    assert.match(prompt, /day.of.week/i);
    assert.match(prompt, /hour/i);
    assert.match(prompt, /weekend|Saturday/i);
    assert.match(prompt, /explicit|time.critical|health reminder|medication/i);
    assert.match(prompt, /least.frequent|coarse|constant polling/i);
  });

  it("describes every supported listener shape and the group rule", () => {
    const prompt = renderAutomationsSystemPrompt([], "/slate/routines");
    for (const type of ["slack", "github", "microsoftTeams", "linear", "sentry", "pagerduty", "group"]) {
      assert.ok(prompt.includes(`"type": "${type}"`), `missing listener type ${type}`);
    }
    for (const value of [...LINEAR_EVENT_CASES, ...SENTRY_EVENT_CASES, ...PAGERDUTY_EVENT_CASES]) assert.ok(prompt.includes(value));
    assert.match(prompt, /never save both|never pass both|never combine|one trigger|instead of a schedule/i);
    assert.match(prompt, /event.driven|event trigger/i);
  });

  it("pins GitHub allowlists, CI branch scope, and Microsoft Teams scope requirements", () => {
    const prompt = renderAutomationsSystemPrompt([], "/slate/routines");
    assert.match(prompt, /userAllowlist/);
    assert.match(prompt, /actor and PR author|both.*actor/i);
    assert.match(prompt, /ciBranch/);
    assert.match(prompt, /ci.passed/);
    assert.match(prompt, /ci.failed/);
    assert.match(prompt, /ciBranch is required for ci.passed and ci.failed/i);
    assert.match(prompt, /tenantId/);
    assert.match(prompt, /teamIds/);
    assert.match(prompt, /channelIds/);
  });

  it("treats event payloads as data and prefers listeners to timer polling", () => {
    const prompt = renderAutomationsSystemPrompt([], "/slate/routines");
    assert.match(prompt, /listener.*over a cron|event.*trigger.*over.*cron/i);
    assert.match(prompt, /do not poll|never poll|don't poll/i);
    assert.match(prompt, /finite watch|deadline/i);
    assert.match(prompt, /self.expiring/i);
  });

  it("keeps connector authorization in the user's account and removes counterpart branding", () => {
    const prompt = renderAutomationsSystemPrompt([], "/slate/routines");
    assert.match(prompt, /connected account|account connection/i);
    assert.match(prompt, /token/i);
    assert.match(prompt, /connect card|connect/i);
    assert.doesNotMatch(prompt, /Cursor/i);
  });

  it("warns about channel membership, approvals, finite watches, and recurring auth failures", () => {
    const prompt = renderAutomationsSystemPrompt([], "/slate/routines");
    assert.match(prompt, /invite.*channel|channel.*invite/i);
    assert.match(prompt, /confirm before|confirmation/i);
    assert.match(prompt, /don't ask for permission yourself|do not ask.*permission/i);
    assert.match(prompt, /don't retry.*denied|do not retry.*denied|denies.*do not retry|deny.*do not retry/i);
    assert.match(prompt, /self.expir|delete.*matching event/i);
    assert.match(prompt, /pause.*routine|pause the routine/i);
    assert.match(prompt, /AuthenticateMcpServer/);
  });

  it("lists current routine identity and state after the general guidance", () => {
    const prompt = renderAutomationsSystemPrompt([routine()], "/slate/routines");
    assert.ok(prompt.indexOf("Current routines:") > prompt.indexOf("Trigger shapes:"));
    assert.match(prompt, /Morning review \[enabled\]/);
    assert.match(prompt, /routine-1/);
    assert.match(prompt, /15 9 \* \* 1-5/);
    const paused = renderAutomationsSystemPrompt([routine({ isEnabled: false })], "/slate/routines");
    assert.match(paused, /Morning review \[paused\]/);
  });
});
