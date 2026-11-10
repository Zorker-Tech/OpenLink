import { SandboxPolicy_Type, type SandboxPolicy as InteropSandboxPolicy } from "../proto/generated/agent/v1/sandbox_pb.ts"
import {
  ShellAbortReason,
  ShellBackgroundReason,
  type ShellResult as InteropShellResult,
} from "../proto/generated/agent/v1/shell_exec_pb.ts"
import {
  renderShellResultToString,
  type RenderShellResult,
  type ShellAbortDisposition,
  type ShellBackgroundDisposition,
  type ShellFormatterOptions,
  type ShellSandboxProfile,
} from "../../../packages/agent/tools/core/shell/formatters.ts"

export interface InteropShellRenderInput {
  readonly result: InteropShellResult["result"]
  readonly sandboxPolicy?: InteropSandboxPolicy | undefined
  readonly isBackground?: boolean | undefined
  readonly terminalsFolder?: string | undefined
}

function fieldsOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}

function stringField(fields: Record<string, unknown>, name: string): string | undefined {
  const value = fields[name]
  return typeof value === "string" ? value : undefined
}

function numberField(fields: Record<string, unknown>, name: string): number | undefined {
  const value = fields[name]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function booleanField(fields: Record<string, unknown>, name: string): boolean | undefined {
  const value = fields[name]
  return typeof value === "boolean" ? value : undefined
}

function projectAbortDisposition(value: unknown): ShellAbortDisposition | undefined {
  if (value === ShellAbortReason.USER_ABORT) return "user"
  if (value === ShellAbortReason.TIMEOUT) return "timeout"
  return undefined
}

function projectBackgroundDisposition(value: unknown): ShellBackgroundDisposition | undefined {
  if (value === ShellBackgroundReason.USER_REQUEST) return "user-request"
  if (value === ShellBackgroundReason.TIMEOUT) return "timeout"
  return undefined
}

function projectSandboxProfile(policy: InteropSandboxPolicy | undefined): ShellSandboxProfile | undefined {
  if (policy === undefined) return undefined
  const mode = policy.type === SandboxPolicy_Type.INSECURE_NONE
    ? "unrestricted"
    : policy.type === SandboxPolicy_Type.WORKSPACE_READONLY
      ? "workspace-readonly"
      : policy.type === SandboxPolicy_Type.WORKSPACE_READWRITE
        ? "workspace-readwrite"
        : "unspecified"
  return {
    mode,
    allowlistEscalated: policy.allowlistEscalated,
    networkAccess: policy.networkAccess,
    networkPolicy: policy.networkPolicy === undefined
      ? undefined
      : { allow: [...policy.networkPolicy.allow] },
  }
}

function projectShellValue(value: unknown): RenderShellResult["result"]["value"] {
  const fields = fieldsOf(value)
  const interleavedOutput = stringField(fields, "interleavedOutput")
  const stderr = stringField(fields, "stderr")
  const stdout = stringField(fields, "stdout")
  const error = stringField(fields, "error")
  const reason = stringField(fields, "reason")
  const isReadonly = booleanField(fields, "isReadonly")
  const timeoutMs = numberField(fields, "timeoutMs")
  const shellId = numberField(fields, "shellId")
  const pid = numberField(fields, "pid")
  const msToWait = numberField(fields, "msToWait")
  const backgroundReason = projectBackgroundDisposition(fields.backgroundReason)
  const exitCode = numberField(fields, "exitCode")
  const signal = stringField(fields, "signal")
  const workingDirectory = stringField(fields, "workingDirectory")
  const localExecutionTimeMs = numberField(fields, "localExecutionTimeMs")
  const executionTime = numberField(fields, "executionTime")
  const abortReason = projectAbortDisposition(fields.abortReason)
  const aborted = booleanField(fields, "aborted")
  const location = fieldsOf(fields.outputLocation)
  const outputLocation = typeof fields.outputLocation === "object" && fields.outputLocation !== null
    ? {
      filePath: stringField(location, "filePath") ?? "",
      sizeBytes: (location.sizeBytes as number | string | bigint | undefined) ?? 0,
      lineCount: (location.lineCount as number | string | bigint | undefined) ?? 0,
    }
    : undefined
  return {
    command: stringField(fields, "command") ?? "",
    ...(interleavedOutput === undefined ? {} : { interleavedOutput }),
    ...(stderr === undefined ? {} : { stderr }),
    ...(stdout === undefined ? {} : { stdout }),
    ...(error === undefined ? {} : { error }),
    ...(reason === undefined ? {} : { reason }),
    ...(isReadonly === undefined ? {} : { isReadonly }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(shellId === undefined ? {} : { shellId }),
    ...(pid === undefined ? {} : { pid }),
    ...(msToWait === undefined ? {} : { msToWait }),
    ...(backgroundReason === undefined ? {} : { backgroundReason }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    ...(outputLocation === undefined ? {} : { outputLocation }),
    ...(localExecutionTimeMs === undefined ? {} : { localExecutionTimeMs }),
    ...(executionTime === undefined ? {} : { executionTime }),
    ...(abortReason === undefined ? {} : { abortReason }),
    ...(aborted === undefined ? {} : { aborted }),
  }
}

/** Translate generated shell-result fields into the formatter's Slate-owned vocabulary. */
export function renderInteropShellResultToString(
  shellResult: InteropShellRenderInput,
  options: ShellFormatterOptions = {},
): string {
  const sandboxPolicy = projectSandboxProfile(shellResult.sandboxPolicy)
  return renderShellResultToString({
    result: {
      ...(shellResult.result.case === undefined ? {} : { case: shellResult.result.case }),
      value: projectShellValue(shellResult.result.value),
    },
    ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
    ...(shellResult.isBackground === undefined ? {} : { isBackground: shellResult.isBackground }),
    ...(shellResult.terminalsFolder === undefined ? {} : { terminalsFolder: shellResult.terminalsFolder }),
  }, options)
}
