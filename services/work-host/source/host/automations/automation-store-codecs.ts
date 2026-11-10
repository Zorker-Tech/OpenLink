import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeSchedule } from "../../shared/automation-schedule.ts";
import { triggerSchedule, type AutomationTrigger } from "../../shared/automations.ts";
import { isSafeFolderId } from "../storage/folder-id.ts";
import {
  AUTOMATION_MAX_RUN_DETAIL_LENGTH,
  MAX_EVENTS_IN_AUTOMATION_WAKE,
  clampAutomationName,
  normalizeAutomationPrompt,
  type AutomationConfig,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationRunTrigger,
} from "./automation.ts";
import { parseStoredTrigger, serializeStoredTrigger } from "./automation-trigger.ts";
import { isRoutineNoticeId } from "./routine-notices.ts";
import {
  AUTOMATIONS_DIRNAME,
  CONFIG_FILENAME,
  type AutomationDefinitionInspection,
} from "./automation-store-contracts.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getAgentAutomationsDir(agentDir: string): string {
  return join(agentDir, AUTOMATIONS_DIRNAME);
}

export function agentHasAutomations(agentDir: string): boolean {
  return inspectAgentAutomationDefinitions(agentDir).validDefinitionCount > 0;
}

export function inspectAgentAutomationDefinitions(agentDir: string): AutomationDefinitionInspection {
  if (!isDirectory(agentDir)) return { state: "agent_missing", validDefinitionCount: 0 };

  let entries;
  try {
    entries = readdirSync(getAgentAutomationsDir(agentDir), { withFileTypes: true });
  } catch {
    return { state: "dir_missing", validDefinitionCount: 0 };
  }

  let candidateCount = 0;
  let validDefinitionCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeFolderId(entry.name)) continue;
    candidateCount += 1;

    const path = join(getAgentAutomationsDir(agentDir), entry.name, CONFIG_FILENAME);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }

    const fallbackCreatedAt = fileCreatedAt(path);
    if (parseStoredConfig(raw, fallbackCreatedAt) != null) validDefinitionCount += 1;
  }

  if (validDefinitionCount > 0) return { state: "valid", validDefinitionCount };
  return { state: candidateCount > 0 ? "configs_invalid" : "dir_empty", validDefinitionCount: 0 };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function parseStoredConfigTrigger(record: Record<string, unknown>): AutomationTrigger | null {
  if (record.trigger != null) {
    const structured = parseStoredTrigger(record.trigger);
    if (structured != null) return structured;
  }

  const legacySchedule = typeof record.schedule === "string" ? normalizeSchedule(record.schedule) : "";
  return legacySchedule.length === 0 ? null : { type: "cron", schedule: legacySchedule };
}

export function parseRaisedNotices(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const notices: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const notice = entry.trim();
    if (notice.length > 0 && !notices.includes(notice) && isRoutineNoticeId(notice)) notices.push(notice);
  }
  return notices;
}

export function parseStoredConfig(raw: string, fallbackCreatedAt: number): AutomationConfig | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(decoded)) return null;

  const name = typeof decoded.name === "string" ? clampAutomationName(decoded.name) : "";
  const prompt = typeof decoded.prompt === "string" ? normalizeAutomationPrompt(decoded.prompt) : "";
  const trigger = parseStoredConfigTrigger(decoded);
  if (!name || !prompt || trigger == null) return null;

  const authoredAt = typeof decoded.createdAt === "number" && Number.isFinite(decoded.createdAt)
    ? decoded.createdAt
    : fallbackCreatedAt;
  const lastRunAt = typeof decoded.lastRunAt === "number" && Number.isFinite(decoded.lastRunAt)
    ? decoded.lastRunAt
    : null;
  return {
    name,
    prompt,
    trigger,
    isEnabled: decoded.enabled !== false,
    createdAt: Math.min(authoredAt, fallbackCreatedAt),
    lastRunAt,
    raisedNotices: parseRaisedNotices(decoded.raisedNotices),
  };
}

export function serializeConfig(config: AutomationConfig): string {
  const schedule = triggerSchedule(config.trigger);
  const payload = {
    name: config.name,
    prompt: config.prompt,
    ...(schedule == null ? {} : { schedule }),
    ...(config.trigger.type === "cron" ? {} : { trigger: serializeStoredTrigger(config.trigger) }),
    enabled: config.isEnabled,
    createdAt: config.createdAt,
    lastRunAt: config.lastRunAt,
    ...(config.raisedNotices.length === 0 ? {} : { raisedNotices: config.raisedNotices }),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function clampRunDetail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const detail = value.trim();
  return detail.length === 0 ? undefined : detail.slice(0, AUTOMATION_MAX_RUN_DETAIL_LENGTH);
}

export function clampCoalescedRunIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .slice(0, MAX_EVENTS_IN_AUTOMATION_WAKE);
  return ids.length === 0 ? undefined : ids;
}

export function parseStoredRun(value: unknown): AutomationRun | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : null;
  const startedAt = typeof value.startedAt === "number" && Number.isFinite(value.startedAt) ? value.startedAt : null;
  if (id == null || startedAt == null) return null;

  const status: AutomationRunStatus = value.status === "error" || value.status === "running" ? value.status : "ok";
  const trigger: AutomationRunTrigger = value.trigger === "manual" || value.trigger === "event" ? value.trigger : "schedule";
  const detail = clampRunDetail(value.detail);
  const event = clampRunDetail(value.event);
  const coalescedRunIds = clampCoalescedRunIds(value.coalescedRunIds);
  const finishedAt = typeof value.finishedAt === "number" && Number.isFinite(value.finishedAt) ? value.finishedAt : null;

  return {
    id,
    trigger,
    startedAt,
    finishedAt,
    status,
    ...(detail === undefined ? {} : { detail }),
    ...(event === undefined ? {} : { event }),
    ...(coalescedRunIds === undefined ? {} : { coalescedRunIds }),
  };
}

function fileCreatedAt(path: string): number {
  try {
    const stats = statSync(path);
    return Math.floor(stats.birthtimeMs || stats.mtimeMs);
  } catch {
    return Date.now();
  }
}
