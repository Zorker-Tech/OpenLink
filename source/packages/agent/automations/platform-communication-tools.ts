/**
 * Which automation tools a subagent may not use.
 *
 * Automations talk to people outside the conversation — they post to Slack, to Teams, to a pull request
 * — and a subagent doing exploratory work has no business speaking on the user's behalf, so those tools
 * are held back from it. They are named twice over: once as the platform's own tools, and once as the
 * MCP tools the same actions are exposed as, because a subagent could otherwise reach them through the
 * MCP route instead. The names are held by server, so the check is a lookup rather than a list scan.
 */

import {
  AUTOMATION_TOOLS_MCP_SERVER_ID,
  OFFER_REPOSITORY_SWITCH_TOOL_NAME,
  SEND_SLACK_MESSAGE_V2_TOOL_NAME,
  SLACK_AGENT_TOOLS_MCP_SERVER_ID,
  SLACK_OFFER_REPOSITORY_SWITCH_MCP_TOOL_NAME,
  SLACK_SEND_MESSAGE_MCP_TOOL_NAME,
  SLACK_SET_STATUS_MCP_TOOL_NAME,
  SLACK_START_STREAMING_MCP_TOOL_NAME,
  START_SLACK_STREAMING_TOOL_NAME,
} from "../constants.ts"
import { automationToolNameToSnakeCase } from "../prompts/bug_report/automations.ts"

const PLATFORM_COMMUNICATION_TOOL_NAMES = [
  "SendSlackMessage",
  "SendMicrosoftTeamsMessage",
  "PostReviewCommentOnPr",
] as const

const platformCommunicationToolNameSet = new Set<string>(PLATFORM_COMMUNICATION_TOOL_NAMES)

export function isAutomationsPlatformCommunicationToolName(toolName: string): boolean {
  return platformCommunicationToolNameSet.has(toolName)
}

const SUBAGENT_EXCLUDED_AUTOMATION_TOOL_NAMES = [
  ...PLATFORM_COMMUNICATION_TOOL_NAMES,
  "PostToPrComment",
] as const

const subagentExcludedToolNameSet = new Set<string>([
  ...SUBAGENT_EXCLUDED_AUTOMATION_TOOL_NAMES,
  SEND_SLACK_MESSAGE_V2_TOOL_NAME,
  OFFER_REPOSITORY_SWITCH_TOOL_NAME,
  START_SLACK_STREAMING_TOOL_NAME,
])

export function isSubagentExcludedPlatformCommunicationToolName(toolName: string): boolean {
  return subagentExcludedToolNameSet.has(toolName)
}

/** The same exclusions, as the MCP tools the actions are also exposed as. */
export const subagentExcludedCommunicationMcpToolNamesByServer = new Map<string, Set<string>>([
  [
    SLACK_AGENT_TOOLS_MCP_SERVER_ID.toLowerCase(),
    new Set([
      SLACK_OFFER_REPOSITORY_SWITCH_MCP_TOOL_NAME,
      SLACK_SEND_MESSAGE_MCP_TOOL_NAME,
      SLACK_SET_STATUS_MCP_TOOL_NAME,
      SLACK_START_STREAMING_MCP_TOOL_NAME,
    ]),
  ],
  [
    AUTOMATION_TOOLS_MCP_SERVER_ID.toLowerCase(),
    new Set(SUBAGENT_EXCLUDED_AUTOMATION_TOOL_NAMES.map(automationToolNameToSnakeCase)),
  ],
])
