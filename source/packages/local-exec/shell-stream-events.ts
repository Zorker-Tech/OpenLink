/** Slate-owned events produced by local shell execution before a transport adapter encodes them. */
import type { ShellCoreEvent } from "./shell-core.ts";
import type { SandboxRule } from "./sandbox-policy.ts";

export type LocalShellStreamEvent =
  | { type: "rejected"; command: string; workingDirectory: string; reason: string }
  | { type: "permissionDenied"; command: string; workingDirectory: string; isReadonly: boolean }
  | { type: "start"; policy?: SandboxRule }
  | { type: "stdout" | "stderr"; data: string }
  | {
      type: "exit";
      code: number;
      cwd: string;
      outputLocation?: Extract<ShellCoreEvent, { type: "exit" }>["outputLocation"];
      aborted: boolean;
      abortReason?: "user_abort" | "timeout";
      localExecutionTimeMs?: number;
    }
  | { type: "sandboxUnsupported"; command: string; workingDirectory: string; policyType: string; reason: string; readonly: boolean }
  | { type: "backgrounded"; shellId: number; command: string; workingDirectory: string; pid?: number; elapsedMs: number; reason: "user" | "timeout" };

export function rejectedShellEvent(command: string, workingDirectory: string, reason: string): LocalShellStreamEvent {
  return { type: "rejected", command, workingDirectory, reason };
}

export function permissionDeniedShellEvent(command: string, workingDirectory: string, isReadonly: boolean): LocalShellStreamEvent {
  return { type: "permissionDenied", command, workingDirectory, isReadonly };
}

export function startedShellEvent(policy: SandboxRule | undefined): LocalShellStreamEvent {
  return policy === undefined ? { type: "start" } : { type: "start", policy };
}

export function shellOutputEvent(type: "stdout" | "stderr", data: string): LocalShellStreamEvent {
  return { type, data };
}

export function shellExitEvent(
  event: Extract<ShellCoreEvent, { type: "exit" }>,
  cwd: string,
  abortReason: "user_abort" | "timeout" | undefined,
): LocalShellStreamEvent {
  return {
    type: "exit",
    code: (event.code ?? 0) >>> 0,
    cwd,
    ...(event.outputLocation === undefined ? {} : { outputLocation: event.outputLocation }),
    aborted: event.aborted,
    ...(event.aborted && abortReason !== undefined ? { abortReason } : {}),
    localExecutionTimeMs: event.localExecutionTimeMs,
  };
}

export function userAbortedShellEvent(cwd: string): LocalShellStreamEvent {
  return { type: "exit", code: 0xffff_ffff, cwd, aborted: true, abortReason: "user_abort" };
}

export function unsupportedSandboxShellEvent(args: {
  command: string;
  workingDirectory: string;
  policyType: string;
  reason: string;
  readonly: boolean;
}): LocalShellStreamEvent {
  return { type: "sandboxUnsupported", ...args };
}

export function backgroundedShellEvent(args: {
  shellId: number;
  command: string;
  workingDirectory: string;
  pid?: number;
  elapsedMs: number;
  reason: "user" | "timeout";
}): LocalShellStreamEvent {
  return { type: "backgrounded", ...args };
}
