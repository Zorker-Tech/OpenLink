/** Slate's view of an MCP server and the tools it exposes to a session. */
export interface McpToolDescriptorView {
  readonly toolName: string
  readonly description?: string | undefined
  readonly inputSchema?: unknown | undefined
  readonly inputSchemaPresent?: boolean | undefined
}

export interface McpServerDescriptorView {
  readonly serverIdentifier: string
  readonly serverName: string
  readonly serverUseInstructions?: string
  readonly plugin?: string
  readonly marketplace?: string
  readonly tools: readonly McpToolDescriptorView[]
  readonly status?: string
  readonly hadMcpAuthBeforeFilter?: boolean
}

/** Inputs selected from a model's discovery request. */
export interface GetMcpToolsRequestView {
  readonly server?: string
  readonly toolName?: string
  readonly pattern?: string
}

/** The result policy produces before the interaction boundary serializes it. */
export type GetMcpToolsResultView =
  | { readonly kind: "success"; readonly content: string; readonly outputFilePath?: string }
  | { readonly kind: "error"; readonly error: string }
  | { readonly kind: "unknown" }
