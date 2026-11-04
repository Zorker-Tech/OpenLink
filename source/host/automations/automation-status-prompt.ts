import { formatTimestamp } from "../../shared/automation-schedule.ts";
import { AUTOMATION_STATUS_PROMPT_MARKER } from "./automation-contracts.ts";
import type { AutomationRecord, AutomationRun } from "./automation-contracts.ts";

function describeLastRun(runs: readonly AutomationRun[], timeZone?: string): string {
  const latest = runs[0];
  if (latest == null) return "never run";
  if (latest.status === "running") return `running now (started ${formatTimestamp(latest.startedAt, timeZone)})`;
  const outcome = latest.status === "ok" ? "succeeded" : "failed";
  return `last run ${formatTimestamp(latest.startedAt, timeZone)} (${outcome})`;
}

function renderAutomationClearedStatusReminder(): string {
  return [
    "<system_reminder>",
    AUTOMATION_STATUS_PROMPT_MARKER,
    "Current routine runtime status. This snapshot is authoritative for this turn and supersedes earlier routine status reminders.",
    "No current routines.",
    "</automation_status>",
    "</system_reminder>",
  ].join("\n");
}

function renderAutomationRuntimeStatusReminder(
  automations: readonly AutomationRecord[],
  timeZone?: string,
  options?: { firingAutomationId?: string },
): string | null {
  if (automations.length === 0) return null;

  const lines = [
    "<system_reminder>",
    AUTOMATION_STATUS_PROMPT_MARKER,
    "Current routine runtime status. This snapshot is authoritative for this turn and supersedes earlier routine status reminders.",
  ];
  for (const automation of automations) {
    const nextRun = automation.isEnabled && automation.nextRunAt != null
      ? `next run ${formatTimestamp(automation.nextRunAt, timeZone)}; `
      : "";
    const runs = automation.id === options?.firingAutomationId
      ? automation.runs.filter((run) => run.status !== "running")
      : automation.runs;
    lines.push(`- ${automation.name} (folder ${automation.id}): ${nextRun}${describeLastRun(runs, timeZone)}`);
  }
  lines.push("</automation_status>", "</system_reminder>");
  return lines.join("\n");
}

export { renderAutomationClearedStatusReminder, renderAutomationRuntimeStatusReminder };
