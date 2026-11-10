/** The permission, ignore and request shapes consumed by local shell streaming. */
import type { Context } from "../context/context.ts";
import type { ShellBlockReason } from "./utils/edit-block-handler.ts";
import type { SandboxRule } from "./sandbox-policy.ts";
import type { analyzeShellCommand } from "../shell-exec/shell-parser.ts";

export type ShellPolicyDecision =
  | { kind: "block"; reason: ShellBlockReason }
  | { kind: "allow"; policy?: SandboxRule };

export interface ShellCommandPermissions {
  shouldEnforceShellInvariantBlocks(ctx: Context, options: unknown, policy: SandboxRule | undefined): Promise<ShellPolicyDecision>;
  shouldBlockShellCommand(ctx: Context, command: string, options: unknown, policy: SandboxRule | undefined): Promise<ShellPolicyDecision>;
}

export interface WorkspaceIgnoreSource {
  getWorkspaceIgnoreMapping(): Promise<unknown>;
}

/** Compatibility names retained for callers of the package's existing public surface. */
export type ShellPermissions = ShellCommandPermissions;
export type ShellIgnoreService = WorkspaceIgnoreSource;

export interface ShellStreamArgs {
  command: string;
  workingDirectory?: string;
  toolCallId?: string;
  conversationId?: string;
  requestedSandboxPolicy?: SandboxRule;
  closeStdin?: boolean;
  timeout?: number;
  timeoutBehavior?: "background" | "foreground";
  hardTimeout?: number;
  fileOutputThresholdBytes?: number;
  adminCommandDenylist?: readonly string[];
  skipApproval?: boolean;
  smartModeApproval?: { reason?: string; requestId?: string };
  classifierResult?: unknown;
  description?: string;
  outputNotification?: unknown;
  hookApprovalRequirement?: unknown;
  isBackground?: boolean;
}

export type ShellCommandParsing = ReturnType<typeof analyzeShellCommand>["structured"];

export interface ShellForegroundResult {
  shellId: number;
  pid?: number;
  command: string;
  workingDirectory: string;
  msToWait: number;
  backgroundReason: "user";
  interleavedOutput: string;
}
export interface ShellForegroundRequest {
  requestBackground(): ShellForegroundResult | undefined;
}
