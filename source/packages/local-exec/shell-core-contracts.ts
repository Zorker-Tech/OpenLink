import type { SandboxRule } from "./sandbox-policy.ts";

export type SandboxPolicy = {
  perUser?: SandboxRule;
  perRepo?: SandboxRule;
  teamAdmin?: SandboxRule;
};

export interface ShellCoreArgs {
  readonly command: string;
  readonly workingDirectory?: string;
  readonly signal?: AbortSignal;
  readonly conversationId?: string;
  readonly sandboxPolicy?: SandboxPolicy;
  readonly pipeStdin?: boolean;
  readonly fileOutputThresholdBytes?: number;
  readonly askpassConfig?: { helperPath: string; socketPath: string; secret: string };
  readonly toolCallId?: string;
  readonly showElapsedTime?: boolean;
}

export interface ShellOutputBackpressureOptions {
  readonly bufferOutputEvents?: boolean;
  readonly outputLimiterOptions?: unknown;
}
