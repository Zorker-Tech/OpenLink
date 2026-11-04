/** Public storage surface for per-agent automation definitions and run history. */

export { FileAutomationStore } from "./automation-store-service.ts";
export {
  AUTOMATIONS_DIRNAME,
  AUTOMATION_CHANGE_DEBOUNCE_MS,
  CONFIG_FILENAME,
  RUNS_FILENAME,
} from "./automation-store-contracts.ts";
export type {
  AutomationDefinitionInspection,
  AutomationDefinitionInspectionState,
} from "./automation-store-contracts.ts";
export {
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
} from "./automation-store-codecs.ts";
