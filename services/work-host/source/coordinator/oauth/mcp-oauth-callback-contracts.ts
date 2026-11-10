import type { CoordinatorLogger, McpOAuthLoopbackRegistry } from "./mcp-oauth-loopback-registry.ts";

export interface McpOAuthCallbackPorts {
  readonly redirectUrl: string;
  readonly resolve: (state: string) => { readonly serverName: string } | undefined;
  readonly onCallback: (value: { readonly code: string; readonly state: string }) => Promise<void>;
  readonly onSettled: (state: string) => void;
  readonly log: CoordinatorLogger;
}

export interface McpOAuthCallbackListener {
  close(): void;
}

export type McpOAuthCallbackRegistry = McpOAuthLoopbackRegistry;
