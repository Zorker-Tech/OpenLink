import { createCiInvestigatorSubagentInteropFields } from "../../../../../adapters/interop/agent/ci-investigator-subagent-adapter.ts"
import type { PromptToolSetHandle } from "./ci-investigator-contracts.ts";
import { buildCiInvestigatorSystemReminder } from "./ci-investigator-prompt.ts";

export function createCiInvestigatorSubagentConfig() {
  const interop = createCiInvestigatorSubagentInteropFields()
  return {
    subagent_type: interop.subagentType,
    description: "Investigate a single failing PR CI check and return a short root-cause summary. Use when the user asks to summarize, explain, diagnose, or investigate a specific failed check from a pull request.",
    preserveTaskTool: true,
    subagentSource: "builtin",
    permissionMode: interop.permissionMode,
    systemReminder: (toolSetHandle: PromptToolSetHandle | undefined) => buildCiInvestigatorSystemReminder(toolSetHandle),
  };
}
