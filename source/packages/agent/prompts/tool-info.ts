/**
 * What the prompt needs to know about the tool set, gathered in one pass.
 *
 * The prompt uses the inventory to describe editing, outside communication, and the agents available to delegate to.
 * A delegated-agent description depends on whether that tool is among the ones shown to the model.
 */

import { isAutomationsPlatformCommunicationToolName } from "../../../adapters/interop/automation/platform-communication-tool-policy-adapter.ts"

interface SubagentDescriptionParts {
  readonly availableSubagentModelsDescriptionText?: unknown
  readonly availableSubagentTypesDescriptionText?: unknown
}

interface PromptTool extends Record<string, unknown> {
  readonly toolIdentifier?: unknown
  readonly name?: unknown
  readonly descriptionTokenPartsGenerator?: unknown
}

type ToolDescriptionProps = Record<string, unknown>
type SubagentDescriptionGenerator = (
  props: ToolDescriptionProps,
  options: { readonly promptVisible: boolean },
) => SubagentDescriptionParts | undefined

interface ToolSetPromptSource {
  getAllTools(): readonly PromptTool[]
  getStaticTools(): readonly PromptTool[]
  getDescriptionProps(): ToolDescriptionProps
  hasTool(identifier: string): boolean
}

interface ExtractedToolInfo {
  readonly hasAnyEditTools: boolean
  readonly allTools: Record<string, unknown>
  readonly automationsCommunicationToolNames: string[]
  readonly availableSubagentModelsDescription: unknown
  readonly availableSubagentTypesDescription: unknown
}

const EDIT_TOOL_IDENTIFIERS = ["WRITE", "STR_REPLACE", "APPLY_PATCH"] as const

export function extractToolInfo(toolSet: ToolSetPromptSource): ExtractedToolInfo {
  const availableTools = toolSet.getAllTools()
  const promptVisibleTools = new Set(toolSet.getStaticTools())
  const descriptionProps = toolSet.getDescriptionProps()
  const toolMetadata = describeToolsForPrompt(availableTools, promptVisibleTools, descriptionProps)

  return {
    hasAnyEditTools: EDIT_TOOL_IDENTIFIERS.some(identifier => toolSet.hasTool(identifier)),
    allTools: descriptionProps.allTools as Record<string, unknown>,
    ...toolMetadata,
  }
}

function describeToolsForPrompt(
  availableTools: readonly PromptTool[],
  promptVisibleTools: ReadonlySet<PromptTool>,
  descriptionProps: ToolDescriptionProps,
): Pick<ExtractedToolInfo, "automationsCommunicationToolNames" | "availableSubagentModelsDescription" | "availableSubagentTypesDescription"> {
  const automationsCommunicationToolNames: string[] = []
  let availableSubagentModelsDescription: unknown
  let availableSubagentTypesDescription: unknown

  for (const tool of availableTools) {
    if (
      tool.toolIdentifier === "PLATFORM_ACTION" &&
      typeof tool.name === "string" &&
      isAutomationsPlatformCommunicationToolName(tool.name)
    ) {
      automationsCommunicationToolNames.push(tool.name)
    }
    if (tool.toolIdentifier !== "TASK" || typeof tool.descriptionTokenPartsGenerator !== "function") continue

    const generateParts = tool.descriptionTokenPartsGenerator as SubagentDescriptionGenerator
    const parts = generateParts(descriptionProps, {
      promptVisible: promptVisibleTools.has(tool),
    })
    availableSubagentModelsDescription = parts?.availableSubagentModelsDescriptionText
    availableSubagentTypesDescription = parts?.availableSubagentTypesDescriptionText
  }

  return {
    automationsCommunicationToolNames,
    availableSubagentModelsDescription,
    availableSubagentTypesDescription,
  }
}
