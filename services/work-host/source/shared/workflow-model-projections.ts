/** Projects workflow records into the other views that consume them. */
import { cronTrigger } from "./automations.ts";
import { describeSchedule } from "./automation-schedule.ts";
import {
  WORKFLOW_UI_LIMIT,
  type AutomationProjection,
  type AutomationWorkflowInput,
  type WorkflowRecord,
  type WorkflowSpec,
} from "./workflow-model-contracts.ts";
import { clampWorkflowDescription, clampWorkflowName, deriveWorkflowNameFromMarkdown } from "./workflow-model-values.ts";
import { parseWorkflowFile } from "./workflow-frontmatter.ts";

export function workflowToAutomation(workflow: WorkflowRecord): AutomationProjection | null {
  const trigger = workflow.trigger;
  if (trigger === null) return null;
  return {
    id: workflow.id,
    name: workflow.name,
    prompt: workflow.body,
    trigger: cronTrigger(trigger.schedule),
    schedule: trigger.schedule,
    triggerDescription: workflow.scheduleDescription ?? describeSchedule(trigger.schedule),
    isEnabled: trigger.isEnabled,
    createdAt: workflow.createdAt,
    lastRunAt: workflow.lastRunAt ?? null,
    nextRunAt: workflow.nextRunAt ?? null,
    runs: workflow.runs ?? [],
    filePath: workflow.filePath,
  };
}

export function automationToWorkflow(automation: AutomationWorkflowInput): WorkflowRecord {
  const schedule = automation.trigger.type === "cron" ? automation.trigger.schedule ?? "" : "";
  return {
    id: automation.id,
    name: automation.name,
    description: "",
    body: automation.prompt,
    trigger: { schedule, isEnabled: automation.isEnabled },
    source: "automation",
    sourceRef: null,
    pluginId: null,
    publishedByCurrentUser: false,
    isEnabledForAgent: true,
    scheduleDescription: automation.triggerDescription,
    createdAt: automation.createdAt,
    lastRunAt: automation.lastRunAt ?? null,
    nextRunAt: automation.nextRunAt ?? null,
    helperScripts: [],
    runs: automation.runs ?? [],
    filePath: automation.filePath,
  };
}

export function limitSurfacedWorkflows<T extends Pick<WorkflowRecord, "source">>(workflows: readonly T[]): T[] {
  const pinned: T[] = [];
  const userDefined: T[] = [];
  for (const workflow of workflows) {
    if (workflow.source === "managed" || workflow.source === "plugin") pinned.push(workflow);
    else userDefined.push(workflow);
  }
  return pinned.concat(userDefined.slice(0, WORKFLOW_UI_LIMIT));
}

export function agentSkillsFromWorkflows(workflows: readonly WorkflowRecord[]): Array<{ fullPath: string; description: string }> {
  return limitSurfacedWorkflows(workflows)
    .filter(workflow => workflow.trigger === null
      && workflow.isEnabledForAgent
      && workflow.disableModelInvocation !== true
      && workflow.filePath.length > 0)
    .map(workflow => ({ fullPath: workflow.filePath, description: workflow.description }));
}

export function workflowSpecFromMarkdown(markdown: string, fallbackName?: string): WorkflowSpec | null {
  const parsed = parseWorkflowFile(markdown);
  if (parsed === null) return null;
  const name = parsed.name || clampWorkflowName(deriveWorkflowNameFromMarkdown(parsed.body) ?? fallbackName ?? "");
  if (name.length === 0 || parsed.body.length === 0) return null;
  return {
    name,
    description: parsed.description,
    body: parsed.body,
    trigger: parsed.trigger,
    sourceRef: parsed.sourceRef,
  };
}

export function workflowDir(filePath: string): string {
  const separator = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return separator < 0 ? filePath : filePath.slice(0, separator);
}

export function renderWorkflowsSystemPrompt(location: string | null | undefined): string {
  if (location == null) return "";
  return `Workflows are a GLOBAL, shared library across all of the user's assistants. User-created skills live as files at ${location}: one subfolder per workflow, each holding a SKILL.md. Prefer the update_state tool (target "workflow") to save, rewrite, and delete them. Reference workflows as [name](slate-workflow:<id>).`;
}
