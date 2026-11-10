import { mcpApprovalPayload, shellApprovalPayload, usefulDescription } from "./slate-auto-review-tool-escalation-projections.ts"
import type {
  McpApprovalProviderOptions,
  McpApprovalRequest,
  ShellApprovalProviderOptions,
  ShellApprovalRequest,
} from "./slate-auto-review-tool-escalations-contracts.ts"

export type { McpApprovalRequest, ShellApprovalRequest, ShellApprovalTarget } from "./slate-auto-review-tool-escalations-contracts.ts"

export function createSlateShellApprovalProvider(options: ShellApprovalProviderOptions) {
  return {
    async requestApproval(request: ShellApprovalRequest) {
      const description = usefulDescription(request.target.description)
      if (options.beforeApproval !== undefined) {
        const accepted = await options.beforeApproval({
          toolCallId: request.toolCallId,
          ...(request.signal == null ? {} : { signal: request.signal }),
          command: request.target.command,
          ...(description === undefined ? {} : { description }),
        })
        if (!accepted.allowed) return { approved: false as const, reason: accepted.reason }
      }

      return options.controller.requestApproval(shellApprovalPayload({
        agentId: options.agentId,
        surface: options.surface,
        expiryPolicy: options.getExpiryPolicy(),
        request,
        target: request.target,
      }))
    },
  }
}

export function createSlateMcpApprovalProvider(options: McpApprovalProviderOptions) {
  return {
    requestApproval(request: McpApprovalRequest) {
      return options.controller.requestApproval(mcpApprovalPayload({
        agentId: options.agentId,
        expiryPolicy: options.getExpiryPolicy(),
        request,
      }))
    },
  }
}
