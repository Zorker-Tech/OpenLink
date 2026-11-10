import {
  describeSlateMcpAutoReviewAction,
  describeSlateShellAutoReviewAction,
  summarizeSlateMcpAutoReviewAction,
} from "./slate-auto-review-summaries.ts"
import type { SlateAutoReviewExpiryPolicy, SlateAutoReviewRequest } from "./slate-auto-review.ts"
import type { McpApprovalRequest, ShellApprovalRequest, ShellApprovalTarget } from "./slate-auto-review-tool-escalations-contracts.ts"

export function usefulDescription(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed == null || trimmed.length === 0 ? undefined : trimmed
}

export function shellApprovalPayload(args: {
  readonly agentId: string
  readonly surface: "host_shell" | "box_shell"
  readonly expiryPolicy: SlateAutoReviewExpiryPolicy
  readonly request: ShellApprovalRequest
  readonly target: ShellApprovalTarget
}): SlateAutoReviewRequest {
  const { request } = args
  const { target } = request
  const description = usefulDescription(target.description)
  return {
    agentId: args.agentId,
    surface: args.surface,
    fingerprint: request.fingerprint,
    reason: target.blockReason,
    summary: describeSlateShellAutoReviewAction({
      surface: args.surface,
      ...(target.workingDirectory == null ? {} : { workingDirectory: target.workingDirectory }),
      ...(description === undefined ? {} : { description }),
    }),
    command: target.command,
    ...(target.proposedAllowRule == null ? {} : { proposedRule: target.proposedAllowRule }),
    ...(request.signal == null ? {} : { signal: request.signal }),
    expiryPolicy: args.expiryPolicy,
  }
}

export function mcpApprovalPayload(args: {
  readonly agentId: string
  readonly expiryPolicy: SlateAutoReviewExpiryPolicy
  readonly request: McpApprovalRequest
}): SlateAutoReviewRequest {
  const { request } = args
  const { target } = request
  const serverDisplayName = target.serverDisplayName ?? target.serverName ?? target.serverIdentifier
  const description = usefulDescription(target.description)
  const details = {
    serverDisplayName,
    toolName: target.toolName,
    ...(target.mcpArguments === undefined ? {} : { mcpArguments: target.mcpArguments }),
    ...(description === undefined ? {} : { description }),
  }
  return {
    agentId: args.agentId,
    surface: "mcp",
    fingerprint: request.fingerprint,
    reason: target.blockReason,
    summary: describeSlateMcpAutoReviewAction(details),
    command: summarizeSlateMcpAutoReviewAction({
      serverDisplayName,
      toolName: target.toolName,
      mcpArguments: target.mcpArguments,
    }),
    ...(target.proposedAllowRule == null ? {} : { proposedRule: target.proposedAllowRule }),
    ...(request.signal == null ? {} : { signal: request.signal }),
    expiryPolicy: args.expiryPolicy,
  }
}
