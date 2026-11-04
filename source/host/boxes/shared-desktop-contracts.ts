import type { Context } from "../../packages/context/context.ts";
import type { CapableBox } from "./box-capabilities.ts";

export const ASSIGNMENTS_LOAD_TIMEOUT_MS = 30_000;
export const ASSIGNMENTS_LOAD_RETRY_INTERVAL_MS = 1_000;
export const DEFAULT_SHARED_BOX_ID = "shared";
export const SHARED_DESKTOP_ASSIGNMENTS_BOX_PATH = "/home/box/.slate-window-assignments.json";

export interface ParsedAssignments {
  readonly assignments: Map<string, number>;
  readonly tokens: Map<string, string>;
  readonly isCorrupt: boolean;
}

export interface SharedInnerBox<Accessor = unknown> extends CapableBox {
  ensureReady(ctx: Context, agentId: string): Promise<{ remoteAccessor: Accessor; vncUrl: string; terminalsFolder?: string }>;
  ensureWindow?(ctx: Context, agentId: string, windowIndex: number, options?: { ownerToken?: string }): Promise<{ windowIndex: number; computerUse: Accessor; vncUrl: string }>;
  releaseWindow?(ctx: Context, agentId: string, windowIndex: number): Promise<void>;
  recreateInBox?(ctx: Context, options: { preserveData: boolean; force?: boolean }): Promise<{ started: boolean; reason?: string }>;
  runState(ctx: Context, agentId: string): Promise<string>;
  listBoxes(): Promise<Array<{ agentId: string; running: boolean }>>;
  uploadFile(ctx: Context, agentId: string, path: string, data: Uint8Array): Promise<void>;
  downloadFile(ctx: Context, agentId: string, path: string): Promise<Uint8Array>;
  dispose?(): Promise<void>;
}

export interface SharedDesktopOptions<Accessor> {
  readonly sharedBoxId?: string;
  readonly persistAssignments?: boolean;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly gateComputerUse?: (primary: { remoteAccessor: Accessor; vncUrl: string; terminalsFolder?: string }) => { remoteAccessor: Accessor; vncUrl: string; terminalsFolder?: string };
  readonly reportPersistFailure?: (error: unknown) => void;
}

export class BoxCapabilityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BoxCapabilityError";
  }
}
