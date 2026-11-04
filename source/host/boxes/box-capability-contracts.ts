import type { Context } from "../../packages/context/context.ts";

export interface BoxCapabilityPort {
  maxWindows?(): number;
  getAgentWindowIndex?(agentId: string): number | undefined;
  getTerminalsFolder?(): string | undefined;
  isAvailable?(): boolean | Promise<boolean>;
  isPreparing?(agentId: string): boolean;
  describe?(): unknown;
  applyEnvironment?(ctx: Context, update: unknown): Promise<void>;
  loadMcpServers?(ctx: Context, configJson: string): Promise<unknown>;
  mcpResourceAccessor?(ctx: Context): Promise<unknown>;
}

export type CapableBox = BoxCapabilityPort;
