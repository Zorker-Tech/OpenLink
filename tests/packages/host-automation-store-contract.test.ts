/**
 * What the per-agent automation store reads, persists, orders and retains across routine and run lifecycles.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AutomationRun, AutomationSpec } from "../../source/host/automations/automation.ts";
import {
  AUTOMATION_MAX_PER_AGENT,
  AUTOMATION_MAX_RUN_DETAIL_LENGTH,
  AUTOMATION_MAX_RUN_HISTORY,
} from "../../source/host/automations/automation.ts";
import {
  AUTOMATIONS_DIRNAME,
  AUTOMATION_CHANGE_DEBOUNCE_MS,
  CONFIG_FILENAME,
  FileAutomationStore,
  RUNS_FILENAME,
  agentHasAutomations,
  clampCoalescedRunIds,
  clampRunDetail,
  getAgentAutomationsDir,
  inspectAgentAutomationDefinitions,
  parseRaisedNotices,
  parseStoredConfig,
  parseStoredConfigTrigger,
  parseStoredRun,
  serializeConfig,
} from "../../source/host/automations/automation-store.ts";
import { GITHUB_LISTENER_SCOPE } from "../../source/host/automations/routine-notices.ts";
import { cronTrigger, type AutomationTrigger } from "../../source/shared/automations.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function world() {
  const root = mkdtempSync(join(tmpdir(), "slate-automation-store-contract-"));
  const agentDir = join(root, "agent-a");
  mkdirSync(agentDir, { recursive: true });
  const store = new FileAutomationStore(getAgentAutomationsDir(agentDir), () => "UTC");
  cleanup.push(() => {
    store.dir.stopWatching();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, agentDir, store };
}

function spec(name: string, trigger: AutomationTrigger = cronTrigger("0 9 * * *"), overrides: Partial<AutomationSpec> = {}): AutomationSpec {
  return { name, prompt: `Run ${name}`, trigger, ...overrides };
}

function validConfig(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "Daily check",
    prompt: "Review the queue",
    schedule: "0 9 * * *",
    enabled: true,
    createdAt: 100,
    lastRunAt: null,
    ...overrides,
  });
}

function storedRun(id: string, startedAt: number): AutomationRun {
  return { id, trigger: "schedule", startedAt, finishedAt: startedAt + 1, status: "ok" };
}

describe("reading persisted automation definitions", () => {
  it("distinguishes a missing agent, missing folder, empty folder and invalid definitions", () => {
    const current = world();
    const missing = join(current.root, "missing-agent");
    assert.deepEqual(inspectAgentAutomationDefinitions(missing), { state: "agent_missing", validDefinitionCount: 0 });
    assert.equal(agentHasAutomations(missing), false);
    assert.deepEqual(inspectAgentAutomationDefinitions(current.agentDir), { state: "dir_missing", validDefinitionCount: 0 });

    mkdirSync(current.store.automationsDir, { recursive: true });
    assert.deepEqual(inspectAgentAutomationDefinitions(current.agentDir), { state: "dir_empty", validDefinitionCount: 0 });

    const invalidDir = join(current.store.automationsDir, "routine-invalid");
    mkdirSync(invalidDir);
    current.store.dir.writeFileAtomic(join(invalidDir, CONFIG_FILENAME), "not json");
    assert.deepEqual(inspectAgentAutomationDefinitions(current.agentDir), { state: "configs_invalid", validDefinitionCount: 0 });

    current.store.dir.writeFileAtomic(join(invalidDir, CONFIG_FILENAME), validConfig());
    assert.deepEqual(inspectAgentAutomationDefinitions(current.agentDir), { state: "valid", validDefinitionCount: 1 });
    assert.equal(agentHasAutomations(current.agentDir), true);
  });

  it("parses and bounds stored fields, clamps future creation time and keeps only known notices", () => {
    const config = parseStoredConfig(validConfig({
      name: "  Daily check  ",
      prompt: "  Look at it  ",
      createdAt: 300,
      lastRunAt: 400,
      enabled: false,
      raisedNotices: [GITHUB_LISTENER_SCOPE, "unknown", ` ${GITHUB_LISTENER_SCOPE} `, 1],
    }), 200);

    assert.deepEqual(config, {
      name: "Daily check",
      prompt: "Look at it",
      trigger: cronTrigger("0 9 * * *"),
      isEnabled: false,
      createdAt: 200,
      lastRunAt: 400,
      raisedNotices: [GITHUB_LISTENER_SCOPE],
    });
    assert.equal(parseStoredConfig("{", 200), null);
    assert.equal(parseStoredConfig("[]", 200), null);
    assert.equal(parseStoredConfig(validConfig({ name: "", prompt: "ok" }), 200), null);
    assert.equal(parseStoredConfig(validConfig({ name: "ok", prompt: " " }), 200), null);
  });

  it("prefers a valid stored trigger and falls back to its legacy schedule when needed", () => {
    const grouped: AutomationTrigger = {
      type: "group",
      listeners: [cronTrigger("0 9 * * *"), { type: "microsoftTeams", tenantId: "t", teamId: "x", teamIds: [], channelIds: [], messageContains: "", messageContainsIsRegex: false, blockUnauthenticatedTeamsUsers: false }],
    };
    assert.deepEqual(parseStoredConfigTrigger({ trigger: grouped, schedule: "0 10 * * *" }), grouped);
    assert.deepEqual(parseStoredConfigTrigger({ trigger: { type: "not-supported" }, schedule: "  0 10 * * * " }), cronTrigger("0 10 * * *"));
    assert.equal(parseStoredConfigTrigger({ trigger: null, schedule: " " }), null);
  });

  it("serializes cron schedules in the legacy field and event triggers in their structured form", () => {
    const cron = parseStoredConfig(validConfig(), 100)!;
    const cronText = serializeConfig(cron);
    assert.equal(cronText.endsWith("\n"), true);
    assert.deepEqual(JSON.parse(cronText), {
      name: "Daily check",
      prompt: "Review the queue",
      schedule: "0 9 * * *",
      enabled: true,
      createdAt: 100,
      lastRunAt: null,
    });

    const event: AutomationTrigger = {
      type: "microsoftTeams",
      tenantId: "tenant-1",
      teamId: "team-1",
      teamIds: [],
      channelIds: [],
      messageContains: "deploy",
      messageContainsIsRegex: false,
      blockUnauthenticatedTeamsUsers: false,
    };
    const eventText = serializeConfig({ ...cron, trigger: event });
    const parsed = JSON.parse(eventText) as Record<string, unknown>;
    assert.equal("schedule" in parsed, false);
    assert.deepEqual(parsed.trigger, event);
  });

  it("normalizes stored run values, trims details and caps coalesced event ids", () => {
    assert.deepEqual(parseStoredRun({ id: "run-1", startedAt: 3, status: "unknown", trigger: "unexpected", detail: "  failed  " }), {
      id: "run-1",
      trigger: "schedule",
      startedAt: 3,
      finishedAt: null,
      status: "ok",
      detail: "failed",
    });
    assert.equal(parseStoredRun({ id: "", startedAt: 3 }), null);
    assert.equal(parseStoredRun({ id: "run-1", startedAt: Number.NaN }), null);
    assert.equal(clampRunDetail("  \n "), undefined);
    assert.equal(clampRunDetail("x".repeat(AUTOMATION_MAX_RUN_DETAIL_LENGTH + 10))?.length, AUTOMATION_MAX_RUN_DETAIL_LENGTH);
    assert.deepEqual(clampCoalescedRunIds(["a", "", 1, "b"]), ["a", "b"]);
    assert.equal(clampCoalescedRunIds(Array.from({ length: 40 }, (_, index) => `id-${index}`))?.length, 25);
    assert.deepEqual(parseRaisedNotices([GITHUB_LISTENER_SCOPE, GITHUB_LISTENER_SCOPE, "unknown"]), [GITHUB_LISTENER_SCOPE]);
  });
});

describe("the automation folder store", () => {
  it("creates, normalizes, lists and resolves a routine with its next run", () => {
    const current = world();
    const createdAt = Date.UTC(2026, 0, 1, 8, 30);
    const created = current.store.upsert(spec("  Morning review  ", cronTrigger(" 0   9 * * * ")), createdAt);
    assert.notEqual(created, null);
    assert.deepEqual(
      [created?.name, created?.prompt, created?.trigger, created?.isEnabled, created?.createdAt, created?.lastRunAt],
      ["Morning review", "Run   Morning review", cronTrigger("0 9 * * *"), true, createdAt, null],
    );
    assert.equal(created?.nextRunAt, Date.UTC(2026, 0, 1, 9, 0));
    assert.equal(created?.schedule, "0 9 * * *");
    assert.equal(created?.runs.length, 0);
    assert.equal(created?.filePath, current.store.configPath(created?.id ?? ""));
    assert.equal(current.store.count(), 1);
    assert.equal(current.store.get(created!.id)?.id, created?.id);
    assert.deepEqual(current.store.list().map((record) => record.id), [created?.id]);
  });

  it("keeps unique ids for repeated names and rejects invalid inputs or unsafe ids", () => {
    const current = world();
    const first = current.store.upsert(spec("Same name"), 10)!;
    const second = current.store.upsert(spec("Same name"), 20)!;
    assert.notEqual(second.id, first.id);
    assert.equal(second.id.startsWith(first.id), true);
    assert.equal(current.store.upsert(spec(" "), 30), null);
    assert.equal(current.store.upsert(spec("empty prompt", cronTrigger("0 9 * * *"), { prompt: " " }), 30), null);
    assert.equal(current.store.get("../outside"), null);
    assert.equal(current.store.update("../outside", spec("changed")), null);
    assert.equal(current.store.remove("../outside"), false);
  });

  it("stops creating routines at the per-agent limit", () => {
    const current = world();
    for (let index = 0; index < AUTOMATION_MAX_PER_AGENT; index += 1) {
      assert.notEqual(current.store.upsert(spec(`Routine ${index}`), index), null);
    }
    assert.equal(current.store.count(), AUTOMATION_MAX_PER_AGENT);
    assert.equal(current.store.upsert(spec("One too many"), 999), null);
  });

  it("sorts full listings by next run and definition listings by creation time", () => {
    const current = world();
    const base = Date.UTC(2026, 0, 1, 8, 30);
    const later = current.store.upsert(spec("later", cronTrigger("0 10 * * *")), base + 200)!;
    const earlier = current.store.upsert(spec("earlier", cronTrigger("0 9 * * *")), base + 100)!;
    const event: AutomationTrigger = {
      type: "microsoftTeams",
      tenantId: "tenant-1",
      teamId: "team-1",
      teamIds: [],
      channelIds: [],
      messageContains: "",
      messageContainsIsRegex: false,
      blockUnauthenticatedTeamsUsers: false,
    };
    const noSchedule = current.store.upsert(spec("event", event), base)!;
    assert.deepEqual(current.store.list().map((record) => record.id), [earlier.id, later.id, noSchedule.id]);
    assert.deepEqual(current.store.listDefinitions().map((record) => record.id), [noSchedule.id, earlier.id, later.id]);
    assert.equal(current.store.listDefinitions()[0]?.nextRunAt, null);
  });

  it("keeps creation/run metadata when an automation definition changes", () => {
    const current = world();
    const original = current.store.upsert(spec("Review"), 100)!;
    current.store.recordRun(original.id, 200);
    const updated = current.store.update(original.id, spec("New title", cronTrigger("0 12 * * *"), { prompt: "  Updated prompt  ", isEnabled: false }))!;
    assert.deepEqual(
      [updated.name, updated.prompt, updated.createdAt, updated.lastRunAt, updated.isEnabled, updated.schedule],
      ["New title", "Updated prompt", 100, 200, false, "0 12 * * *"],
    );
    assert.equal(current.store.update("missing", spec("No routine")), null);
  });

  it("marks a known notice once and changes enabled state only when it changes", () => {
    const current = world();
    const created = current.store.upsert(spec("Notice"), 100)!;
    const writes: string[] = [];
    const write = current.store.dir.writeFileAtomic.bind(current.store.dir);
    current.store.dir.writeFileAtomic = (path, contents) => {
      writes.push(path);
      write(path, contents);
    };

    assert.equal(current.store.markNoticeRaised(created.id, "unknown-notice"), null);
    assert.equal(current.store.markNoticeRaised("../bad", GITHUB_LISTENER_SCOPE), null);
    const marked = current.store.markNoticeRaised(created.id, GITHUB_LISTENER_SCOPE)!;
    assert.deepEqual(marked.raisedNotices, [GITHUB_LISTENER_SCOPE]);
    current.store.markNoticeRaised(created.id, GITHUB_LISTENER_SCOPE);
    assert.equal(writes.length, 1);

    assert.equal(current.store.setEnabled(created.id, false)?.isEnabled, false);
    current.store.setEnabled(created.id, false);
    assert.equal(writes.length, 2);
  });

  it("records a run once, clamps its text and updates the automation's anchor", () => {
    const current = world();
    const created = current.store.upsert(spec("Run"), 100)!;
    const coalescedRunIds = Array.from({ length: 40 }, (_, index) => `run-${index}`);
    const run = current.store.beginRun({
      id: created.id,
      trigger: "event",
      at: 200,
      event: `  ${"event".repeat(100)}  `,
      runId: "run-stable",
      coalescedRunIds,
    })!;
    assert.deepEqual(
      [run.id, run.trigger, run.startedAt, run.finishedAt, run.status, run.event?.length, run.coalescedRunIds?.length],
      ["run-stable", "event", 200, null, "running", AUTOMATION_MAX_RUN_DETAIL_LENGTH, 25],
    );
    assert.deepEqual(current.store.beginRun({ id: created.id, trigger: "manual", at: 999, runId: "run-stable" }), run);

    const finished = current.store.finishRun(created.id, run.id, "error", 300, ` ${"x".repeat(500)} `)!;
    assert.deepEqual([finished.lastRunAt, finished.runs[0]?.status, finished.runs[0]?.finishedAt, finished.runs[0]?.detail?.length], [null, "error", 300, AUTOMATION_MAX_RUN_DETAIL_LENGTH]);
    assert.equal(current.store.recordRun(created.id, 400)?.lastRunAt, 400);
  });

  it("sorts, filters and caps run history, returning an empty history for unreadable data", () => {
    const current = world();
    const created = current.store.upsert(spec("History"), 100)!;
    current.store.writeRuns(created.id, [
      { nope: true } as unknown as AutomationRun,
      ...Array.from({ length: AUTOMATION_MAX_RUN_HISTORY + 5 }, (_, index) => storedRun(`run-${index}`, index)),
    ]);
    const runs = current.store.readRuns(created.id);
    assert.equal(runs.length, AUTOMATION_MAX_RUN_HISTORY);
    assert.equal(runs[0]?.startedAt, AUTOMATION_MAX_RUN_HISTORY + 4);
    current.store.dir.writeFileAtomic(current.store.runsPath(created.id), "bad json");
    assert.deepEqual(current.store.readRuns(created.id), []);
  });

  it("removes only an existing safe automation folder", () => {
    const current = world();
    const created = current.store.upsert(spec("Remove"), 100)!;
    assert.equal(current.store.remove("missing"), false);
    assert.equal(current.store.remove(created.id), true);
    assert.equal(current.store.get(created.id), null);
    assert.equal(current.store.remove(created.id), false);
  });
});
