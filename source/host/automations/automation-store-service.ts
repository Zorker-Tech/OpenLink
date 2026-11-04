import type { WatchedDirectory } from "../watched-directory.ts";
import { automationAnchor, computeNextRunAt, describeTrigger, normalizeSchedule } from "../../shared/automation-schedule.ts";
import {
  cronTrigger,
  triggerCronSchedules,
  triggerFromList,
  triggerList,
  triggerSchedule,
  type AutomationTrigger,
} from "../../shared/automations.ts";
import { isSafeFolderId } from "../storage/folder-id.ts";
import {
  AUTOMATION_MAX_PER_AGENT,
  AUTOMATION_MAX_RUN_HISTORY,
  clampAutomationName,
  createAutomationRunId,
  normalizeAutomationPrompt,
  slugifyAutomationName,
  type AutomationConfig,
  type AutomationRecord,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationRunTrigger,
  type AutomationSpec,
} from "./automation.ts";
import { parseStoredTrigger, serializeStoredTrigger } from "./automation-trigger.ts";
import { isRoutineNoticeId } from "./routine-notices.ts";
import {
  clampCoalescedRunIds,
  clampRunDetail,
} from "./automation-store-codecs.ts";
import { AutomationFileRepository } from "./automation-store-files.ts";

export class FileAutomationStore {
  readonly dir: WatchedDirectory;
  private readonly files: AutomationFileRepository;

  constructor(
    readonly automationsDir: string,
    readonly resolveUserTimeZone: () => string | undefined = () => undefined,
  ) {
    this.files = new AutomationFileRepository(automationsDir);
    this.dir = this.files.watchedDirectory;
  }

  getLocation(): string {
    return this.files.location();
  }

  setOnChange(listener?: (() => void) | null): void {
    this.files.setOnChange(listener);
  }

  configPath(id: string): string {
    return this.files.configPath(id);
  }

  runsPath(id: string): string {
    return this.files.runsPath(id);
  }

  toRecord(id: string, config: AutomationConfig, deriveNextRunAt: boolean): AutomationRecord {
    const nextRunAt = deriveNextRunAt && config.isEnabled ? this.earliestNextRunAt(config) : null;
    return {
      id,
      ...config,
      schedule: triggerSchedule(config.trigger) ?? "",
      triggerDescription: describeTrigger(config.trigger),
      nextRunAt,
      runs: this.readRuns(id),
      filePath: this.configPath(id),
    };
  }

  earliestNextRunAt(config: AutomationConfig): number | null {
    const anchor = automationAnchor(config);
    const timeZone = this.resolveUserTimeZone();
    let earliest: number | null = null;

    for (const schedule of triggerCronSchedules(config.trigger)) {
      const next = computeNextRunAt(schedule, anchor, timeZone);
      if (next != null && (earliest == null || next < earliest)) earliest = next;
    }
    return earliest;
  }

  readRuns(id: string): AutomationRun[] {
    return this.files.readRuns(id);
  }

  writeRuns(id: string, runs: readonly AutomationRun[]): void {
    this.files.writeRuns(id, runs);
  }

  readConfig(id: string): AutomationConfig | null {
    return this.files.readConfig(id);
  }

  writeConfig(id: string, config: AutomationConfig): void {
    this.files.writeConfig(id, config);
  }

  listIds(): string[] {
    return this.files.listIds();
  }

  list(): AutomationRecord[] {
    return this.listWithNextRun()
      .sort((left, right) =>
        (left.nextRunAt ?? Infinity) - (right.nextRunAt ?? Infinity)
        || left.createdAt - right.createdAt,
      );
  }

  listDefinitions(): AutomationRecord[] {
    return this.listWithNextRun(false).sort((left, right) => left.createdAt - right.createdAt);
  }

  get(id: string): AutomationRecord | null {
    if (!isSafeFolderId(id)) return null;
    const config = this.readConfig(id);
    return config == null ? null : this.toRecord(id, config, true);
  }

  count(): number {
    return this.listIds().filter((id) => this.readConfig(id) != null).length;
  }

  uniqueId(name: string): string {
    const base = slugifyAutomationName(name);
    const existing = new Set(this.listIds());
    if (!existing.has(base)) return base;

    for (let suffix = 2; suffix < 1_000; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!existing.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  normalizeSpecTrigger(trigger: AutomationTrigger): AutomationTrigger | null {
    const members: ReturnType<typeof triggerList> = [];
    for (const member of triggerList(trigger)) {
      if (member.type !== "cron") {
        members.push(member);
        continue;
      }

      const schedule = normalizeSchedule(member.schedule);
      if (!schedule) return null;
      members.push(cronTrigger(schedule));
    }

    const normalized = triggerFromList(members);
    if (normalized == null || normalized.type === "cron") return normalized;
    return parseStoredTrigger(serializeStoredTrigger(normalized));
  }

  upsert(spec: AutomationSpec, createdAt = Date.now()): AutomationRecord | null {
    const name = clampAutomationName(spec.name);
    const prompt = normalizeAutomationPrompt(spec.prompt);
    const trigger = this.normalizeSpecTrigger(spec.trigger);
    if (!name || !prompt || trigger == null || this.count() >= AUTOMATION_MAX_PER_AGENT) return null;

    const id = this.uniqueId(name);
    const config: AutomationConfig = {
      name,
      prompt,
      trigger,
      isEnabled: spec.isEnabled ?? true,
      createdAt,
      lastRunAt: null,
      raisedNotices: [],
    };
    this.writeConfig(id, config);
    return this.toRecord(id, config, true);
  }

  update(id: string, spec: AutomationSpec): AutomationRecord | null {
    if (!isSafeFolderId(id)) return null;
    const current = this.readConfig(id);
    const name = clampAutomationName(spec.name);
    const prompt = normalizeAutomationPrompt(spec.prompt);
    const trigger = this.normalizeSpecTrigger(spec.trigger);
    if (current == null || !name || !prompt || trigger == null) return null;

    const updated: AutomationConfig = {
      ...current,
      name,
      prompt,
      trigger,
      isEnabled: spec.isEnabled ?? current.isEnabled,
    };
    this.writeConfig(id, updated);
    return this.toRecord(id, updated, true);
  }

  markNoticeRaised(id: string, notice: string): AutomationRecord | null {
    if (!isSafeFolderId(id) || !isRoutineNoticeId(notice)) return null;
    const current = this.readConfig(id);
    if (current == null) return null;

    const updated = current.raisedNotices.includes(notice)
      ? current
      : { ...current, raisedNotices: [...current.raisedNotices, notice] };
    if (updated !== current) this.writeConfig(id, updated);
    return this.toRecord(id, updated, true);
  }

  setEnabled(id: string, isEnabled: boolean): AutomationRecord | null {
    if (!isSafeFolderId(id)) return null;
    const current = this.readConfig(id);
    if (current == null) return null;

    const updated = current.isEnabled === isEnabled ? current : { ...current, isEnabled };
    if (updated !== current) this.writeConfig(id, updated);
    return this.toRecord(id, updated, true);
  }

  recordRun(id: string, at = Date.now()): AutomationRecord | null {
    return this.recordRunWith(id, at, true);
  }

  recordRunDefinition(id: string, at = Date.now()): AutomationRecord | null {
    return this.recordRunWith(id, at, false);
  }

  recordRunWith(id: string, at: number, deriveNextRunAt: boolean): AutomationRecord | null {
    if (!isSafeFolderId(id)) return null;
    const current = this.readConfig(id);
    if (current == null) return null;

    const updated = { ...current, lastRunAt: at };
    this.writeConfig(id, updated);
    return this.toRecord(id, updated, deriveNextRunAt);
  }

  beginRun(args: {
    readonly id: string;
    readonly trigger: AutomationRunTrigger;
    readonly at?: number;
    readonly event?: string;
    readonly runId?: string;
    readonly coalescedRunIds?: string[];
  }): AutomationRun | null {
    const { id, trigger, at = Date.now(), event, runId = createAutomationRunId(), coalescedRunIds } = args;
    if (!isSafeFolderId(id) || this.readConfig(id) == null) return null;

    const runs = this.readRuns(id);
    const prior = runs.find((run) => run.id === runId);
    if (prior != null) return prior;

    const eventSummary = clampRunDetail(event);
    const absorbedIds = clampCoalescedRunIds(coalescedRunIds);
    const run: AutomationRun = {
      id: runId,
      trigger,
      startedAt: at,
      finishedAt: null,
      status: "running",
      ...(eventSummary === undefined ? {} : { event: eventSummary }),
      ...(absorbedIds === undefined ? {} : { coalescedRunIds: absorbedIds }),
    };
    this.writeRuns(id, [run, ...runs].slice(0, AUTOMATION_MAX_RUN_HISTORY));
    return run;
  }

  finishRun(
    id: string,
    runId: string,
    status: Exclude<AutomationRunStatus, "running">,
    at = Date.now(),
    detail?: string,
  ): AutomationRecord | null {
    return this.finishRunWith(id, runId, status, at, detail, true);
  }

  finishRunDefinition(args: {
    readonly id: string;
    readonly runId: string;
    readonly status: Exclude<AutomationRunStatus, "running">;
    readonly at?: number;
    readonly detail?: string;
  }): AutomationRecord | null {
    return this.finishRunWith(args.id, args.runId, args.status, args.at ?? Date.now(), args.detail, false);
  }

  finishRunWith(
    id: string,
    runId: string,
    status: Exclude<AutomationRunStatus, "running">,
    at: number,
    detail: string | undefined,
    deriveNextRunAt: boolean,
  ): AutomationRecord | null {
    if (!isSafeFolderId(id)) return null;
    const config = this.readConfig(id);
    if (config == null) return null;

    const runs = this.readRuns(id);
    const runIndex = runs.findIndex((run) => run.id === runId);
    if (runIndex === -1) return this.toRecord(id, config, deriveNextRunAt);

    const currentRun = runs[runIndex] as AutomationRun;
    const boundedDetail = clampRunDetail(detail);
    runs[runIndex] = {
      ...currentRun,
      finishedAt: at,
      status,
      ...(boundedDetail === undefined ? {} : { detail: boundedDetail }),
    };
    this.writeRuns(id, runs);
    return this.toRecord(id, config, deriveNextRunAt);
  }

  remove(id: string): boolean {
    if (!isSafeFolderId(id)) return false;
    return this.files.removeFolder(id);
  }

  private listWithNextRun(deriveNextRunAt = true): AutomationRecord[] {
    return this.listIds().flatMap((id) => {
      const config = this.readConfig(id);
      return config == null ? [] : [this.toRecord(id, config, deriveNextRunAt)];
    });
  }
}
