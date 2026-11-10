import type { SlateAutoReviewController, SlateAutoReviewExpiryPolicy, SlateAutoReviewRequest } from "./slate-auto-review.ts"

export interface ShellApprovalTarget {
  readonly command: string
  readonly workingDirectory?: string
  readonly description?: string
  readonly blockReason: string
  readonly proposedAllowRule?: string
}

export interface ShellApprovalRequest {
  readonly target: ShellApprovalTarget
  readonly fingerprint: string
  readonly toolCallId: string
  readonly signal?: AbortSignal
}

export interface ShellApprovalProviderOptions {
  readonly controller: Pick<SlateAutoReviewController, "requestApproval">
  readonly agentId: string
  readonly surface: "host_shell" | "box_shell"
  readonly getExpiryPolicy: () => SlateAutoReviewExpiryPolicy
  readonly beforeApproval?: (args: {
    readonly toolCallId: string
    readonly signal?: AbortSignal
    readonly command: string
    readonly description?: string
  }) => Promise<{ readonly allowed: boolean; readonly reason?: string }>
}

export interface McpApprovalRequest {
  readonly kind: "mcp"
  readonly target: {
    readonly serverIdentifier: string
    readonly serverName?: string
    readonly serverDisplayName?: string
    readonly toolName: string
    readonly mcpMode: string
    readonly mcpArguments?: unknown
    readonly toolDefinitionIdentity?: string
    readonly toolDefinitionHash?: string
    readonly blockReason: string
    readonly description?: string
    readonly proposedAllowRule?: string
  }
  readonly fingerprint: string
  readonly toolCallId: string
  readonly conversationId: string | undefined
  readonly signal: AbortSignal
}

export interface McpApprovalProviderOptions {
  readonly controller: Pick<SlateAutoReviewController, "requestApproval">
  readonly agentId: string
  readonly getExpiryPolicy: () => SlateAutoReviewExpiryPolicy
}
