/** Public automation contracts and prompt builders. Detailed behavior lives by responsibility in adjacent modules. */

export {
  AUTOMATION_MAX_NAME_LENGTH,
  AUTOMATION_MAX_PER_AGENT,
  AUTOMATION_UI_LIMIT,
  AUTOMATION_MAX_RUN_HISTORY,
  AUTOMATION_MAX_RUN_DETAIL_LENGTH,
  MAX_EVENTS_IN_AUTOMATION_WAKE,
  AUTOMATION_STATUS_PROMPT_MARKER,
  AUTOMATION_PROMPT_GUIDANCE_VERSION,
} from "./automation-contracts.ts";
export type {
  AutomationRunTrigger,
  AutomationRunStatus,
  AutomationRun,
  AutomationConfig,
  AutomationRecord,
  AutomationSpec,
} from "./automation-contracts.ts";

export {
  clampAutomationName,
  normalizeAutomationPrompt,
  slugifyAutomationName,
  createAutomationRunId,
} from "./automation-text.ts";

export { renderAutomationsSystemPrompt } from "./automation-system-prompt.ts";

export {
  clampWakeEvents,
  describeTriggerEventBatch,
  buildGroupAutomationSeed,
  buildAutomationWakePrompt,
} from "./automation-wake-prompt.ts";

export {
  renderAutomationClearedStatusReminder,
  renderAutomationRuntimeStatusReminder,
} from "./automation-status-prompt.ts";
