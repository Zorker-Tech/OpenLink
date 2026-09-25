/**
 * What the prompt needs to know about the tool set, gathered in one pass.
 *
 * The prompt is assembled from the tools themselves rather than from a hand-written list, so the four
 * things it asks about are read off the assembled set: whether the agent can edit anything at all
 * (which changes how the work is described), which tools speak to people outside the conversation,
 * what the subagent descriptions say, and what every tool is called for a description that refers to
 * another tool by name.
 *
 * A subagent description is generated per call rather than stored, and it is told whether the tool is
 * visible to the model — the same generator words the two cases differently.
 */

import { isAutomationsPlatformCommunicationToolName } from "../automations/platform-communication-tools.ts"

interface ExtractedToolInfo {
  readonly hasAnyEditTools: boolean
  readonly allTools: Record<string, unknown>
  readonly automationsCommunicationToolNames: string[]
  readonly availableSubagentModelsDescription: unknown
  readonly availableSubagentTypesDescription: unknown
}

export function extractToolInfo(toolSetHandle: {
  getAllTools(): readonly Record<string, any>[]
  getStaticTools(): readonly Record<string, any>[]
  getDescriptionProps(): { allTools: Record<string, unknown> }
  hasTool(identifier: string): boolean
}): ExtractedToolInfo {
  const availableTools = toolSetHandle.getAllTools()
  const promptVisibleTools = toolSetHandle.getStaticTools()
  const descriptionProps = toolSetHandle.getDescriptionProps()
  const automationsCommunicationToolNames: string[] = []
  let availableSubagentModelsDescription: unknown
  let availableSubagentTypesDescription: unknown
  for (const tool of availableTools) {
    if (tool.toolIdentifier === "PLATFORM_ACTION" && isAutomationsPlatformCommunicationToolName(tool.name)) {
      automationsCommunicationToolNames.push(tool.name)
    }
    if (tool.toolIdentifier === "TASK" && "descriptionTokenPartsGenerator" in tool) {
      const tokenParts = tool.descriptionTokenPartsGenerator?.(descriptionProps, { promptVisible: promptVisibleTools.includes(tool) })
      availableSubagentModelsDescription = tokenParts?.availableSubagentModelsDescriptionText
      availableSubagentTypesDescription = tokenParts?.availableSubagentTypesDescriptionText
    }
  }
  return {
    hasAnyEditTools: toolSetHandle.hasTool("WRITE") || toolSetHandle.hasTool("STR_REPLACE") || toolSetHandle.hasTool("APPLY_PATCH"),
    allTools: descriptionProps.allTools,
    automationsCommunicationToolNames,
    availableSubagentModelsDescription,
    availableSubagentTypesDescription,
  }
}
