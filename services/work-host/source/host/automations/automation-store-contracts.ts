import type { AutomationConfig, AutomationRun, AutomationRunStatus, AutomationRunTrigger } from "./automation.ts";

export const AUTOMATIONS_DIRNAME = "automations";
export const CONFIG_FILENAME = "automation.json";
export const RUNS_FILENAME = "runs.json";
export const AUTOMATION_CHANGE_DEBOUNCE_MS = 50;

export type AutomationDefinitionInspectionState = "agent_missing" | "dir_missing" | "valid" | "configs_invalid" | "dir_empty";

export interface AutomationDefinitionInspection {
  readonly state: AutomationDefinitionInspectionState;
  readonly validDefinitionCount: number;
}

export type StoredAutomationRun = AutomationRun;
export type StoredRunStatus = AutomationRunStatus;
export type StoredRunTrigger = AutomationRunTrigger;
export type StoredAutomationConfig = AutomationConfig;
