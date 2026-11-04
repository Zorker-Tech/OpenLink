/** Slate-owned values and record shapes shared by workflow readers and projections. */
import { WORKFLOW_REFERENCE_NODE_TYPE } from "./workflows.ts";
import { cronTrigger } from "./automations.ts";

export const WORKFLOW_FILENAME = "SKILL.md";
export const LEGACY_WORKFLOW_FILENAME = "workflow.md";
export const AGENT_READABLE_SKILL_DIR_MODE = 0o755;
export const AGENT_READABLE_SKILL_FILE_MODE = 0o644;
export const WORKFLOW_MAX_NAME_LENGTH = 80;
export const WORKFLOW_MAX_DESCRIPTION_LENGTH = 1_536;
export const WORKFLOW_MAX_BODY_LENGTH = 100_000;
export const WORKFLOW_INJECTED_BODY_LIMIT = 8_000;
export const WORKFLOW_UI_LIMIT = 100;
export const WORKFLOW_MAX_PER_AGENT = 100;

export interface WorkflowTrigger {
  schedule: string;
  isEnabled: boolean;
}

export interface WorkflowSpec {
  name: string;
  description: string;
  body: string;
  trigger: WorkflowTrigger | null;
  sourceRef?: string | null;
}

export interface ParsedWorkflow extends WorkflowSpec {
  sourceRef: string | null;
  data: Record<string, unknown>;
}

export interface WorkflowRecord {
  id: string;
  name: string;
  description: string;
  body: string;
  trigger: WorkflowTrigger | null;
  source: "managed" | "plugin" | "workflow" | "automation";
  sourceRef: string | null;
  pluginId?: string | null;
  publishedByCurrentUser?: boolean;
  isEnabledForAgent: boolean;
  disableModelInvocation?: boolean;
  scheduleDescription?: string | null;
  createdAt: number;
  lastRunAt?: number | null;
  nextRunAt?: number | null;
  helperScripts: readonly string[];
  runs?: readonly unknown[];
  filePath: string;
}

export interface AutomationProjection {
  id: string;
  name: string;
  prompt: string;
  trigger: ReturnType<typeof cronTrigger>;
  schedule: string;
  triggerDescription: string;
  isEnabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  runs: readonly unknown[];
  filePath: string;
}

export interface AutomationWorkflowInput {
  id: string;
  name: string;
  prompt: string;
  trigger: { type: string; schedule?: string };
  triggerDescription: string;
  isEnabled: boolean;
  createdAt: number;
  lastRunAt?: number | null;
  nextRunAt?: number | null;
  runs?: readonly unknown[];
  filePath: string;
}

export { WORKFLOW_REFERENCE_NODE_TYPE };
