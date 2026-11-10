import type { SlateLocalToolPermission } from "../../../shared/local-tool-permission.ts";
import type {
  SlateLocalToolRequest,
  SlateLocalToolScope,
} from "../../../shared/local-tool-permission-machinery.ts";

export const SLATE_LOCAL_TOOL_SETTLED_ID_MEMORY = 64;
export const SLATE_LOCAL_TOOL_REFUSAL_DIRECTION_WINDOW = 64;
export const SLATE_LOCAL_TOOL_REFUSED_ACTION_MEMORY_PER_AGENT = 512;
export const SLATE_LOCAL_TOOL_FORGOTTEN_AGENT_MEMORY = 256;
export const SLATE_LOCAL_TOOL_TARGET_MAX_CHARS = 10_000;
export const SLATE_LOCAL_TOOLS_ASK_CANCELLED_MESSAGE =
  "The request to use the user's computer was cancelled before the user answered.";

export type SlateLocalToolResolution = "allow-once" | "deny" | "always" | "never";
export type SlateLocalToolRequestStatus = "pending" | "allowed" | "denied" | "always" | "never" | "expired";

export interface SlateLocalToolAskRequest {
  readonly id: string;
  readonly agentId: string;
  readonly action: SlateLocalToolRequest["action"];
  readonly target: string;
  readonly status: SlateLocalToolRequestStatus;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly description?: string;
}

export interface SlateLocalToolDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly approvalId?: string;
}

export interface SlateLocalToolControllerEvent {
  readonly type: "created" | "settled";
  readonly request: SlateLocalToolAskRequest;
}

export interface PendingLocalToolAsk {
  request: SlateLocalToolAskRequest;
  readonly waiters: Set<(decision: SlateLocalToolDecision) => void>;
  readonly expiryAbort: AbortController;
  readonly toolCallId: string;
  readonly resourcePath?: string;
  readonly outlivesScope: boolean;
  readonly directionEpoch: number;
}

export interface SlateLocalToolPermissionControllerOptions {
  readonly getPermission: () => SlateLocalToolPermission;
  readonly setPermission: (permission: "always" | "never") => void;
  readonly canAsk?: (agentId: string) => boolean;
  readonly hasLiveComputer?: (agentId: string) => boolean;
  readonly onApprovalRetired?: (approvalId: string) => void;
  readonly askTtlMs?: number;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

export interface LocalToolRefusalEntry {
  readonly agentId: string;
  readonly directionEpoch: number;
}

export interface LocalToolRefusalAttempt {
  readonly agentId: string;
  readonly action: SlateLocalToolRequest["action"];
  readonly target: string;
  readonly directionEpoch: number;
}

export type LocalToolScope = SlateLocalToolScope & { readonly toolCallId: string };
