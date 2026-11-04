export interface RoutedMcpTool {
  readonly name: string;
  readonly providerIdentifier: string;
  readonly toolName: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface RoutedMcpBridgeDependencies {
  readonly listTools: () => Promise<unknown>;
  readonly callTool: (args: RoutedMcpTool & { readonly args: unknown; readonly toolCallId: string }) => Promise<unknown>;
}

export interface RoutedMcpBridge {
  readonly url: string;
  close(): Promise<void>;
}
