import type { SandboxRule } from "./sandbox-policy.ts";

export interface BackgroundShellSpawnInput {
  readonly command: string;
  readonly workingDirectory?: string;
  readonly toolCallId?: string;
  readonly conversationId?: string;
  readonly sandboxPolicy?: SandboxRule;
  readonly adminCommandDenylist?: readonly string[];
  readonly skipApproval?: boolean;
  readonly smartModeApproval?: { readonly reason?: string; readonly requestId?: string };
  readonly classifierResult?: unknown;
  readonly enableWriteShellStdinTool?: boolean;
  readonly description?: string;
  readonly outputNotification?: unknown;
  readonly hookApprovalRequirement?: unknown;
}

export type BackgroundShellSpawnOutcome =
  | { readonly kind: "success"; readonly shellId: number; readonly command: string; readonly workingDirectory: string; readonly pid?: number }
  | { readonly kind: "rejected"; readonly command: string; readonly workingDirectory: string; readonly reason: string }
  | { readonly kind: "permission_denied"; readonly command: string; readonly workingDirectory: string; readonly error: string; readonly isReadonly: boolean }
  | { readonly kind: "sandbox_unsupported"; readonly command: string; readonly workingDirectory: string; readonly sandboxPolicyType: string; readonly reason: string; readonly isReadonly: boolean }
  | { readonly kind: "error"; readonly command: string; readonly workingDirectory: string; readonly error: string };
