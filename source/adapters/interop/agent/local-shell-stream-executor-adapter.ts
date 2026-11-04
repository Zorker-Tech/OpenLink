/** Encodes Slate's local shell events and foreground handoff outcomes as generated executor messages. */

import {
  ForceBackgroundShellResult,
  ForceBackgroundShellStatus,
  ShellAbortReason,
  ShellBackgroundReason,
  ShellPermissionDenied,
  ShellRejected,
  ShellResult,
  ShellSandboxUnsupported,
  ShellStream,
  ShellStreamBackgrounded,
  ShellStreamExit,
  ShellStreamStart,
  ShellStreamStderr,
  ShellStreamStdout,
  ShellSuccess,
  TimeoutBehavior,
} from "../proto/generated/agent/v1/shell_exec_pb.ts"
import { adaptSandboxPolicyToInterop } from "./sandbox-policy-adapter.ts"
import type { Context } from "../../../packages/context/context.ts"
import type { LocalShellStreamExecutor, LocalShellForegroundHandoff } from "../../../packages/local-exec/shell-stream.ts"
import type { ShellStreamArgs } from "../../../packages/local-exec/shell-stream-contracts.ts"
import type { LocalShellStreamEvent } from "../../../packages/local-exec/shell-stream-events.ts"

export function localShellStreamEventToInterop(event: LocalShellStreamEvent): ShellStream {
  switch (event.type) {
    case "rejected":
      return new ShellStream({
        event: { case: "rejected", value: new ShellRejected({ command: event.command, workingDirectory: event.workingDirectory, reason: event.reason }) },
      })
    case "permissionDenied":
      return new ShellStream({
        event: {
          case: "permissionDenied",
          value: new ShellPermissionDenied({
            command: event.command,
            workingDirectory: event.workingDirectory,
            error: "Command blocked by permissions configuration",
            isReadonly: event.isReadonly,
          }),
        },
      })
    case "start": {
      const sandboxPolicy = event.policy === undefined ? undefined : adaptSandboxPolicyToInterop(event.policy)
      return new ShellStream({
        event: { case: "start", value: new ShellStreamStart(sandboxPolicy === undefined ? {} : { sandboxPolicy }) },
      })
    }
    case "stdout":
      return new ShellStream({ event: { case: "stdout", value: new ShellStreamStdout({ data: event.data }) } })
    case "stderr":
      return new ShellStream({ event: { case: "stderr", value: new ShellStreamStderr({ data: event.data }) } })
    case "exit":
      return new ShellStream({
        event: {
          case: "exit",
          value: new ShellStreamExit({
            code: event.code,
            cwd: event.cwd,
            ...(event.outputLocation === undefined ? {} : { outputLocation: event.outputLocation as never }),
            aborted: event.aborted,
            ...(event.abortReason === undefined ? {} : {
              abortReason: event.abortReason === "user_abort" ? ShellAbortReason.USER_ABORT : ShellAbortReason.TIMEOUT,
            }),
            ...(event.localExecutionTimeMs === undefined ? {} : { localExecutionTimeMs: event.localExecutionTimeMs }),
          }),
        },
      })
    case "sandboxUnsupported":
      return new ShellStream({
        event: {
          case: "sandboxUnsupported",
          value: new ShellSandboxUnsupported({
            command: event.command,
            workingDirectory: event.workingDirectory,
            sandboxPolicyType: event.policyType,
            reason: event.reason,
            isReadonly: event.readonly,
          }),
        },
      })
    case "backgrounded":
      return new ShellStream({
        event: {
          case: "backgrounded",
          value: new ShellStreamBackgrounded({
            shellId: event.shellId,
            command: event.command,
            workingDirectory: event.workingDirectory,
            ...(event.pid === undefined ? {} : { pid: event.pid }),
            msToWait: event.elapsedMs,
            reason: event.reason === "user" ? ShellBackgroundReason.USER_REQUEST : ShellBackgroundReason.TIMEOUT,
          }),
        },
      })
  }
}

/** Maps the generated timeout preference to the local executor's shell mode. */
export function shellTimeoutBehaviorFromInterop(value: unknown): "background" | "foreground" {
  return value === TimeoutBehavior.BACKGROUND ? "background" : "foreground"
}

/** Builds the stderr stream event used when a shell's requested directory falls back to the workspace root. */
export function shellStderrEventFromInterop(data: string): ShellStream {
  return new ShellStream({ event: { case: "stderr", value: new ShellStreamStderr({ data }) } })
}

/** Projects the command fact used by Slate's turn auditor from an opaque shell executor request. */
export function shellCommandFromInteropRequest(value: unknown): string {
  const command = typeof value === "object" && value !== null ? Reflect.get(value, "command") : undefined
  if (typeof command !== "string") throw new TypeError("shell executor request is missing a command")
  return command
}

export function localShellForegroundHandoffToInterop(outcome: LocalShellForegroundHandoff): ForceBackgroundShellResult {
  if (outcome.status === "not_found") return new ForceBackgroundShellResult({ status: ForceBackgroundShellStatus.NOT_FOUND })
  const shellResult = outcome.shellResult
  return new ForceBackgroundShellResult({
    status: ForceBackgroundShellStatus.ACCEPTED,
    shellResult: new ShellResult({
      result: {
        case: "success",
        value: new ShellSuccess({
          shellId: shellResult.shellId,
          ...(shellResult.pid === undefined ? {} : { pid: shellResult.pid }),
          command: shellResult.command,
          workingDirectory: shellResult.workingDirectory,
          msToWait: shellResult.msToWait,
          backgroundReason: ShellBackgroundReason.USER_REQUEST,
          interleavedOutput: shellResult.interleavedOutput,
        }),
      },
    }),
  })
}

export function createInteropLocalShellStreamExecutor(executor: LocalShellStreamExecutor) {
  return {
    async *execute(context: Context, args: ShellStreamArgs): AsyncIterable<ShellStream> {
      for await (const event of executor.execute(context, args)) yield localShellStreamEventToInterop(event)
    },
    async forceBackgroundByToolCallId(toolCallId: string): Promise<ForceBackgroundShellResult> {
      return localShellForegroundHandoffToInterop(await executor.forceBackgroundByToolCallId(toolCallId))
    },
  }
}
