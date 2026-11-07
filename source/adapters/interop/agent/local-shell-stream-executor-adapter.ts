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
  ShellStreamHookContext,
  ShellStreamStart,
  ShellStreamStderr,
  ShellStreamStdout,
  ShellSuccess,
  TimeoutBehavior,
} from "../proto/generated/agent/v1/shell_exec_pb.ts"
import { adaptSandboxPolicyFromInterop, adaptSandboxPolicyToInterop } from "./sandbox-policy-adapter.ts"
import type { Context } from "../../../packages/context/context.ts"
import type { LocalShellStreamExecutor, LocalShellForegroundHandoff } from "../../../packages/local-exec/shell-stream.ts"
import type { ShellStreamArgs } from "../../../packages/local-exec/shell-stream-contracts.ts"
import type { LocalShellStreamEvent } from "../../../packages/local-exec/shell-stream-events.ts"
import { fromInteropHookContextMessages, toInteropHookContextMessages } from "./hook-context-adapter.ts"

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
            error: event.message ?? "Command blocked by permissions configuration",
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
              abortReason: typeof event.abortReason === "object"
                ? event.abortReason.code as ShellAbortReason
                : event.abortReason === "user_abort" ? ShellAbortReason.USER_ABORT : ShellAbortReason.TIMEOUT,
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
            ...(event.elapsedMs === undefined ? {} : { msToWait: event.elapsedMs }),
            ...(event.reason === undefined ? {} : {
              reason: typeof event.reason === "object"
                ? event.reason.code as ShellBackgroundReason
                : event.reason === "user" ? ShellBackgroundReason.USER_REQUEST : ShellBackgroundReason.TIMEOUT,
            }),
          }),
        },
      })
    case "hookContext":
      return new ShellStream({
        event: { case: "hookContext", value: new ShellStreamHookContext({ hookAdditionalContexts: toInteropHookContextMessages(event.contexts) }) },
      })
    case "unrecognized":
      return new ShellStream()
  }
}

/** Projects a generated stream message into Slate's shell event vocabulary. */
export function localShellStreamEventFromInterop(stream: ShellStream): LocalShellStreamEvent {
  const event = stream.event
  switch (event.case) {
    case "rejected":
      return { type: "rejected", command: event.value.command, workingDirectory: event.value.workingDirectory, reason: event.value.reason }
    case "permissionDenied":
      return {
        type: "permissionDenied",
        command: event.value.command,
        workingDirectory: event.value.workingDirectory,
        isReadonly: event.value.isReadonly,
        message: event.value.error,
      }
    case "start": {
      const policy = event.value.sandboxPolicy === undefined ? undefined : adaptSandboxPolicyFromInterop(event.value.sandboxPolicy)
      return policy === undefined ? { type: "start" } : { type: "start", policy }
    }
    case "stdout":
    case "stderr":
      return { type: event.case, data: event.value.data }
    case "exit": {
      const reason = event.value.abortReason
      const abortReason = reason === undefined
        ? undefined
        : reason === ShellAbortReason.USER_ABORT
          ? "user_abort"
          : reason === ShellAbortReason.TIMEOUT
            ? "timeout"
            : { kind: "unknown" as const, code: reason }
      return {
        type: "exit",
        code: event.value.code,
        cwd: event.value.cwd,
        ...(event.value.outputLocation === undefined ? {} : {
          outputLocation: {
            filePath: event.value.outputLocation.filePath,
            sizeBytes: BigInt(event.value.outputLocation.sizeBytes),
            lineCount: BigInt(event.value.outputLocation.lineCount),
          },
        }),
        aborted: event.value.aborted,
        ...(abortReason === undefined ? {} : { abortReason }),
        ...(event.value.localExecutionTimeMs === undefined ? {} : { localExecutionTimeMs: event.value.localExecutionTimeMs }),
      }
    }
    case "sandboxUnsupported":
      return {
        type: "sandboxUnsupported",
        command: event.value.command,
        workingDirectory: event.value.workingDirectory,
        policyType: event.value.sandboxPolicyType,
        reason: event.value.reason,
        readonly: event.value.isReadonly,
      }
    case "backgrounded": {
      const reason = event.value.reason
      const backgroundReason = reason === undefined
        ? undefined
        : reason === ShellBackgroundReason.USER_REQUEST
          ? "user"
          : reason === ShellBackgroundReason.TIMEOUT
            ? "timeout"
            : { kind: "unknown" as const, code: reason }
      return {
        type: "backgrounded",
        shellId: event.value.shellId,
        command: event.value.command,
        workingDirectory: event.value.workingDirectory,
        ...(event.value.pid === undefined ? {} : { pid: event.value.pid }),
        ...(event.value.msToWait === undefined ? {} : { elapsedMs: event.value.msToWait }),
        ...(backgroundReason === undefined ? {} : { reason: backgroundReason }),
      }
    }
    case "hookContext":
      return { type: "hookContext", contexts: fromInteropHookContextMessages(event.value.hookAdditionalContexts) }
    case undefined:
      return { type: "unrecognized" }
  }
}

/** Maps the generated timeout preference to the local executor's shell mode. */
export function shellTimeoutBehaviorFromInterop(value: unknown): "background" | "foreground" {
  return value === TimeoutBehavior.BACKGROUND ? "background" : "foreground"
}

/** Encodes Slate's shell timeout preference at the generated transport edge. */
export function shellTimeoutBehaviorToInterop(value: "background" | "foreground" | undefined): TimeoutBehavior {
  return value === undefined
    ? TimeoutBehavior.UNSPECIFIED
    : value === "background" ? TimeoutBehavior.BACKGROUND : TimeoutBehavior.CANCEL
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
