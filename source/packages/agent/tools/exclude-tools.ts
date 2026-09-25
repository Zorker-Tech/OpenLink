/**
 * Which tools the model is offered, and which are kept behind discovery.
 *
 * A session with many tools pays for every one of them in its prompt, so the ones that are not always
 * needed are held back and reached through discovery instead. What stays visible is decided by what the
 * tool is rather than by a list: a meta tool, a tool with its own wire format, a tool whose context is
 * forced static, and the tools that speak to people outside the conversation — which a subagent must not
 * reach — are always offered. The rest are held back under the final profile, except the question tool
 * and the platform's own native tools, which are what a session needs in hand.
 */

import { ToolCall } from "../../proto/generated/agent/v1/agent_pb.ts"
import { isSubagentExcludedPlatformCommunicationToolName } from "../automations/platform-communication-tools.ts"
import { isForcedStaticContext } from "./tool-execution.ts"

type ToolLike = {
  readonly name: string
  readonly toolIdentifier?: string
  readonly dynamicToolMetaRole?: string
  readonly customToolFormat?: unknown
  readonly contextType?: { readonly type?: string }
}

const TOOL_CALL_TOOL_FIELDS = ToolCall.fields
  .list()
  .filter(field => field.oneof?.localName === "tool")

const BASE_STATIC_NATIVE_TOOL_IDENTIFIERS = new Set([
  "ANTHROPIC_COMPUTER_USE",
  "APPLY_PATCH",
  "EXTERNAL_READ",
  "COMMUNICATE_UPDATE",
  "CREATE_PLAN",
  "CREATE_PLAN_V2",
  "GEMINI_COMPUTER_USE",
  "GLOB",
  "GREP",
  "OPENAI_COMPUTER_USE",
  "PR_MANAGEMENT",
  "READ",
  "RECORD_SCREEN",
  "SEND_MESSAGE",
  "SETUP_VM_ENVIRONMENT",
  "SHELL",
  "STR_REPLACE",
  "WRITE",
])

function shouldOffloadTool(profile: "all-static" | "final", toolIdentifier: string): boolean {
  switch (profile) {
    case "all-static":
      return false
    case "final":
      return toolIdentifier !== "ASK_QUESTION" && !BASE_STATIC_NATIVE_TOOL_IDENTIFIERS.has(toolIdentifier)
    default: {
      const exhaustive: never = profile
      return exhaustive
    }
  }
}

/** The tool names the agent protocol knows, for callers that need to recognize one by name. */
export const AGENT_PROTO_TOOL_NAMES: readonly string[] = TOOL_CALL_TOOL_FIELDS.map(field => field.name)

export function partitionDynamicTools(
  tools: readonly ToolLike[],
  profile: "all-static" | "final",
): { readonly staticTools: ToolLike[]; readonly dynamicTools: ToolLike[] } {
  const staticTools: ToolLike[] = []
  const dynamicTools: ToolLike[] = []
  for (const tool of tools) {
    if (
      tool.dynamicToolMetaRole !== undefined ||
      ("customToolFormat" in tool && tool.customToolFormat !== undefined) ||
      isForcedStaticContext(tool.contextType) ||
      (tool.toolIdentifier === "PLATFORM_ACTION" && isSubagentExcludedPlatformCommunicationToolName(tool.name))
    ) {
      staticTools.push(tool)
      continue
    }
    if (shouldOffloadTool(profile, tool.toolIdentifier ?? "")) dynamicTools.push(tool)
    else staticTools.push(tool)
  }
  return { staticTools, dynamicTools }
}
