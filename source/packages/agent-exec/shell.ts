/** Slate's command execution request, outcome and resource. */

import type { Executor } from "./executor-resources.ts";
import type { CommandClassifierInternalResult } from "../agent/utils/agent-config-contracts.ts";
import type { SandboxRule } from "../local-exec/sandbox-policy.ts";

export interface ShellCommandArgument {
  readonly type: string;
  readonly value: string;
}

export interface ShellExecutableCommand {
  readonly name: string;
  readonly fullText: string;
  readonly arguments: readonly ShellCommandArgument[];
}

export interface ShellCommandRedirect {
  readonly operator: string;
  readonly destinationFileDescriptors: readonly number[];
  readonly targetNodeType: string;
  readonly targetText?: string;
}

export interface ShellCommandParsing {
  readonly failed: boolean;
  readonly executableCommands: readonly ShellExecutableCommand[];
  readonly hasRedirects: boolean;
  readonly hasCommandSubstitution: boolean;
  readonly allRedirectsAreDevNull?: boolean;
  readonly redirects: readonly ShellCommandRedirect[];
}

export interface ShellOutputNotification {
  readonly pattern: string;
  readonly reason: string;
  readonly notificationLimit?: number;
  readonly debounceSeconds?: number;
}

export type ShellHookApprovalRequirement =
  | { readonly kind: "force-prompt"; readonly reason?: string }
  | { readonly kind: "unknown"; readonly code: number; readonly reason?: string };

export type ShellKnownOrUnknownReason<Known extends string> =
  | Known
  | { readonly kind: "unknown"; readonly code: number };

export interface ShellExecutorArgs {
  readonly command: string;
  readonly workingDirectory?: string;
  readonly timeout?: number;
  readonly toolCallId?: string;
  readonly simpleCommands?: readonly string[];
  readonly hasInputRedirect?: boolean;
  readonly hasOutputRedirect?: boolean;
  readonly parsing?: ShellCommandParsing;
  readonly requestedSandboxPolicy?: SandboxRule;
  readonly fileOutputThresholdBytes?: bigint;
  readonly isBackground?: boolean;
  readonly skipApproval?: boolean;
  readonly timeoutBehavior?: "foreground" | "background" | { readonly kind: "unknown"; readonly code: number };
  readonly hardTimeout?: number;
  readonly description?: string;
  readonly classifierResult?: CommandClassifierInternalResult;
  readonly closeStdin?: boolean;
  readonly outputNotification?: ShellOutputNotification;
  readonly smartModeApproval?: { readonly reason?: string; readonly requestId?: string };
  readonly hookApprovalRequirement?: ShellHookApprovalRequirement;
  readonly conversationId?: string;
  readonly adminCommandDenylist?: readonly string[];
}

export interface ShellOutputLocation {
  readonly filePath: string;
  readonly sizeBytes: bigint;
  readonly lineCount: bigint;
}

interface ShellOutputFields {
  readonly command: string;
  readonly workingDirectory: string;
  readonly exitCode: number;
  readonly signal: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly executionTimeMs: number;
  readonly outputFile?: ShellOutputLocation;
  readonly interleavedOutput?: string;
  readonly processId?: number;
  readonly waitedMs?: number;
  readonly localExecutionTimeMs?: number;
  readonly outputHead?: string;
  readonly outputTail?: string;
  readonly elidedCharacters?: number;
}

export type ShellExecResult =
  | ({ readonly kind: "success" } & ShellOutputFields & { readonly shellId?: number; readonly backgroundReason?: ShellKnownOrUnknownReason<"user" | "timeout"> })
  | ({ readonly kind: "failure" } & ShellOutputFields & { readonly aborted: boolean; readonly abortReason?: ShellKnownOrUnknownReason<"user-abort" | "timeout"> })
  | { readonly kind: "timeout"; readonly command: string; readonly workingDirectory: string; readonly timeoutMs: number }
  | { readonly kind: "rejected"; readonly command: string; readonly workingDirectory: string; readonly reason: string; readonly isReadonly: boolean }
  | { readonly kind: "spawn-error"; readonly command: string; readonly workingDirectory: string; readonly message: string }
  | { readonly kind: "permission-denied"; readonly command: string; readonly workingDirectory: string; readonly message: string; readonly isReadonly: boolean }
  | { readonly kind: "unrecognized" };

export interface ShellExecResponse {
  readonly outcome: ShellExecResult;
  readonly sandboxPolicy?: SandboxRule;
  readonly isBackground?: boolean;
  readonly terminalsFolder?: string;
  readonly processId?: number;
}

export type ShellExecutor = Executor<ShellExecutorArgs, ShellExecResponse>;

export { shellExecutorResource } from "../../adapters/interop/agent/shell-operation-adapter.ts";
