import type { NoticeAutomation } from "./routine-notices.ts";
import type { AutomationTrigger } from "../../shared/automations.ts";

export const AUTOMATION_MAX_NAME_LENGTH = 80;
export const AUTOMATION_MAX_PER_AGENT = 50;
export const AUTOMATION_UI_LIMIT = 100;
export const AUTOMATION_MAX_RUN_HISTORY = 20;
export const AUTOMATION_MAX_RUN_DETAIL_LENGTH = 300;
export const MAX_EVENTS_IN_AUTOMATION_WAKE = 25;
export const AUTOMATION_STATUS_PROMPT_MARKER = "<automation_status>";
export const AUTOMATION_PROMPT_GUIDANCE_VERSION = "backend_triggers_v4";

export type AutomationRunTrigger = "schedule" | "manual" | "event";
export type AutomationRunStatus = "running" | "ok" | "error";

export interface AutomationRun {
  id: string;
  trigger: AutomationRunTrigger;
  startedAt: number;
  finishedAt: number | null;
  status: AutomationRunStatus;
  detail?: string;
  event?: string;
  coalescedRunIds?: string[];
}

export interface AutomationConfig extends NoticeAutomation {
  name: string;
  prompt: string;
  trigger: AutomationTrigger;
  isEnabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
  raisedNotices: string[];
}

export interface AutomationRecord extends AutomationConfig {
  id: string;
  schedule: string;
  triggerDescription: string;
  nextRunAt: number | null;
  runs: AutomationRun[];
  filePath: string;
}

export interface AutomationSpec {
  name: string;
  prompt: string;
  trigger: AutomationTrigger;
  isEnabled?: boolean;
}
