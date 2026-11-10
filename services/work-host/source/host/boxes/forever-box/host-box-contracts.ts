import type { Context } from "../../../packages/context/context.ts";

export interface BoxStatus {
  agentId: string;
  state: string;
  vncUrl: string | null;
  windows?: Array<{ windowIndex: number; vncUrl: string }>;
  imageUpdateAvailable?: boolean;
  pull?: { percent: number };
}

export interface BoxConnection {
  vncUrl: string;
  imageUpdateAvailable?: boolean;
  remoteAccessor?: unknown;
}

export interface HostBoxInner {
  ensureReady(ctx: Context, agentId: string): Promise<BoxConnection>;
  runState(ctx: Context, agentId: string): Promise<string>;
  listBoxes(): Promise<Array<{ agentId: string; running?: boolean }>>;
  uploadFile(ctx: Context, agentId: string, path: string, data: Uint8Array): Promise<void>;
  downloadFile(ctx: Context, agentId: string, path: string): Promise<Uint8Array>;
  ensureWindow?(ctx: Context, agentId: string, windowIndex: number, options?: unknown): Promise<{ windowIndex: number; vncUrl: string }>;
  releaseWindow?(ctx: Context, agentId: string): Promise<void>;
  recreateInBox?(ctx: Context, options: { preserveData: boolean; force?: boolean }): Promise<{ started: boolean; reason?: string }>;
  getAgentWindowIndex?(agentId: string): number | undefined;
  maxWindows?(): number;
  getTerminalsFolder?(): string | undefined;
  isAvailable?(): boolean | Promise<boolean>;
  isPreparing?(agentId: string): boolean;
  describe?(): unknown;
  applyEnvironment?(ctx: Context, update: unknown): Promise<void>;
  loadMcpServers?(ctx: Context, configJson: string): Promise<unknown>;
  mcpResourceAccessor?(ctx: Context): Promise<unknown>;
}
