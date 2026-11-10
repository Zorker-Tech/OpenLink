export interface McpApprovalFingerprintInput {
  readonly serverIdentifier: string
  readonly serverName?: string | undefined
  readonly serverDisplayName?: string | undefined
  readonly toolName: string
  readonly mcpMode: string
  readonly mcpArguments?: unknown
  readonly toolDefinitionIdentity?: string | undefined
  readonly toolDefinitionHash?: string | undefined
  readonly blockReason: string
}
