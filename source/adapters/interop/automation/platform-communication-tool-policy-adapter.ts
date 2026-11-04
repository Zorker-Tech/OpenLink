/** Provider tool identifiers and dispatch exclusions used at the automation boundary. */

import { AUTOMATION_TOOLS_MCP_SERVER_ID } from "../../../packages/agent/constants.ts";
import { automationToolNameToSnakeCase } from "../../../packages/agent/prompts/bug_report/automations.ts";

export const SEND_SLACK_MESSAGE_V2_TOOL_NAME = "SendSlackMessageV2";
export const OFFER_REPOSITORY_SWITCH_TOOL_NAME = "OfferRepositorySwitch";
export const START_SLACK_STREAMING_TOOL_NAME = "StartSlackStreaming";

export const SLACK_AGENT_TOOLS_MCP_SERVER_ID = "Slate Slack Tools";
export const SLACK_SEND_MESSAGE_MCP_TOOL_NAME = "send_slack_message";
export const SLACK_OFFER_REPOSITORY_SWITCH_MCP_TOOL_NAME = "offer_repository_switch";
export const SLACK_START_STREAMING_MCP_TOOL_NAME = "start_slack_streaming";
export const SLACK_SET_STATUS_MCP_TOOL_NAME = "set_slack_status";

const AUTOMATION_COMMUNICATION_TOOL_NAMES = [
  "SendSlackMessage",
  "SendMicrosoftTeamsMessage",
  "PostReviewCommentOnPr",
] as const;

const AUTOMATION_COMMUNICATION_TOOL_NAME_SET = new Set<string>(AUTOMATION_COMMUNICATION_TOOL_NAMES);
const SUBAGENT_BLOCKED_AUTOMATION_TOOL_NAMES = [
  ...AUTOMATION_COMMUNICATION_TOOL_NAMES,
  "PostToPrComment",
] as const;
const SUBAGENT_BLOCKED_TOOL_NAME_SET = new Set<string>([
  ...SUBAGENT_BLOCKED_AUTOMATION_TOOL_NAMES,
  SEND_SLACK_MESSAGE_V2_TOOL_NAME,
  OFFER_REPOSITORY_SWITCH_TOOL_NAME,
  START_SLACK_STREAMING_TOOL_NAME,
]);

export function isAutomationsPlatformCommunicationToolName(toolName: string): boolean {
  return AUTOMATION_COMMUNICATION_TOOL_NAME_SET.has(toolName);
}

export function isSubagentExcludedPlatformCommunicationToolName(toolName: string): boolean {
  return SUBAGENT_BLOCKED_TOOL_NAME_SET.has(toolName);
}

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
    new Set(SUBAGENT_BLOCKED_AUTOMATION_TOOL_NAMES.map(automationToolNameToSnakeCase)),
  ],
]);
