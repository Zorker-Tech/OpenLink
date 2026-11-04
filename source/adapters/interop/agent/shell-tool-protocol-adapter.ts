import { Struct, type JsonValue } from "@bufbuild/protobuf"
import { ToolCall } from "../proto/generated/agent/v1/agent_pb.ts"
import { SandboxPolicy, SandboxPolicy_Type } from "../proto/generated/agent/v1/sandbox_pb.ts"
import {
  ShellArgs,
  ShellCommandParsingResult,
  ShellCommandParsingResult_ExecutableCommand,
  ShellCommandParsingResult_ExecutableCommandArg,
  ShellCommandParsingResult_Redirect,
  ShellFailure,
  ShellPermissionDenied,
  ShellRejected,
  ShellResult,
  ShellSpawnError,
  ShellSuccess,
  ShellTimeout,
  TimeoutBehavior,
  type ShellStream,
} from "../proto/generated/agent/v1/shell_exec_pb.ts"
import { ShellToolCall } from "../proto/generated/agent/v1/shell_tool_pb.ts"
import {
  SmartModeClassifierArgs,
  SmartModeClassifierDecision,
  SmartModeRiskTarget,
  type SmartModeClassifierResult,
} from "../proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts"
import { renderInteropShellResultToString } from "./shell-result-format-adapter.ts"

export type ShellArgsInterop = ShellArgs
export type ShellStreamInterop = ShellStream
export type ShellResultInterop = ShellResult
export type ShellToolCallInterop = ShellToolCall
export type ShellToolEnvelopeInterop = ToolCall
export type ShellTimeoutBehaviorInterop = "background"

export interface ShellSandboxPolicy {
  readonly mode: "workspace_readonly" | "workspace_readwrite" | "unrestricted"
  readonly networkAccess?: boolean
  readonly additionalReadwritePaths?: readonly string[]
  readonly enableSharedBuildCache?: boolean
}

export type ShellStreamEventViewInterop =
  | { readonly kind: "stdout" | "stderr"; readonly data: string }
  | {
      readonly kind: "exit"
      readonly code: number
      readonly aborted: boolean
      readonly localExecutionTimeMs?: number
      readonly outputLocation?: unknown
      readonly abortReason?: unknown
    }
  | { readonly kind: "rejected"; readonly command: string; readonly workingDirectory: string; readonly reason: string }
  | { readonly kind: "permission-denied"; readonly command: string; readonly workingDirectory: string; readonly error: string; readonly isReadonly: boolean }
  | { readonly kind: "sandbox-unsupported"; readonly reason: string }
  | {
      readonly kind: "backgrounded"
      readonly command: string
      readonly workingDirectory: string
      readonly shellId: number
      readonly pid?: number
      readonly msToWait?: number
      readonly reason?: number
    }
  | { readonly kind: "other" }

export type SmartModeClassifierDecisionViewInterop =
  | { readonly kind: "allow" }
  | { readonly kind: "block"; readonly reason?: string; readonly proposedAllowRule?: string }
  | { readonly kind: "unknown" }

export function createShellSandboxPolicyInterop(input: {
  readonly mode: ShellSandboxPolicy["mode"]
  readonly networkAccess?: boolean
  readonly additionalReadwritePaths?: readonly string[]
  readonly enableSharedBuildCache?: boolean
}): SandboxPolicy {
  const type = input.mode === "workspace_readonly"
    ? SandboxPolicy_Type.WORKSPACE_READONLY
    : input.mode === "workspace_readwrite"
      ? SandboxPolicy_Type.WORKSPACE_READWRITE
      : SandboxPolicy_Type.INSECURE_NONE
  return new SandboxPolicy({
    type,
    ...(input.networkAccess === undefined ? {} : { networkAccess: input.networkAccess }),
    ...(input.additionalReadwritePaths === undefined ? {} : { additionalReadwritePaths: [...input.additionalReadwritePaths] }),
    ...(input.enableSharedBuildCache === undefined ? {} : { enableSharedBuildCache: input.enableSharedBuildCache }),
  })
}

export function shellSandboxPolicyFingerprintInterop(policy: ShellSandboxPolicy | undefined): JsonValue | null {
  if (policy === undefined) return null
  return createShellSandboxPolicyInterop(policy).toJson({ emitDefaultValues: true }) as JsonValue
}

export function escalatedShellSandboxPolicyInterop(policy: ShellSandboxPolicy | undefined): ShellSandboxPolicy {
  return {
    mode: "unrestricted",
    ...(policy?.enableSharedBuildCache === undefined ? {} : { enableSharedBuildCache: policy.enableSharedBuildCache }),
  }
}

export function createSmartModeRiskTargetInterop(input: {
  readonly action: string
  readonly arguments: Record<string, unknown>
}): InstanceType<typeof SmartModeRiskTarget> {
  return new SmartModeRiskTarget({
    action: input.action,
    arguments: Struct.fromJson(toJsonRecord(input.arguments)),
  })
}

export function createSmartModeClassifierArgsInterop(input: {
  readonly toolCallId: string
  readonly parentConversationId?: string
  readonly target: InstanceType<typeof SmartModeRiskTarget>
  readonly conversationContext: readonly unknown[]
}): InstanceType<typeof SmartModeClassifierArgs> {
  return new SmartModeClassifierArgs({
    toolCallId: input.toolCallId,
    ...(input.parentConversationId === undefined ? {} : { parentConversationId: input.parentConversationId }),
    target: input.target,
    conversationContext: [...input.conversationContext] as never,
  })
}

export function projectSmartModeClassifierDecisionInterop(
  result: SmartModeClassifierResult,
): SmartModeClassifierDecisionViewInterop {
  if (result.result.case !== "success") return { kind: "unknown" }
  switch (result.result.value.decision) {
    case SmartModeClassifierDecision.ALLOW:
      return { kind: "allow" }
    case SmartModeClassifierDecision.BLOCK:
      return {
        kind: "block",
        ...(result.result.value.blockReason === undefined ? {} : { reason: result.result.value.blockReason }),
        ...(result.result.value.proposedAllowRule === undefined ? {} : { proposedAllowRule: result.result.value.proposedAllowRule }),
      }
    default:
      return { kind: "unknown" }
  }
}

export function createShellArgsInterop(input: {
  readonly command: string
  readonly workingDirectory: string
  readonly timeout: number
  readonly toolCallId: string
  readonly simpleCommands: readonly string[]
  readonly hasInputRedirect: boolean
  readonly hasOutputRedirect: boolean
  readonly parsingResult: {
    readonly parsingFailed: boolean
    readonly hasRedirects: boolean
    readonly hasCommandSubstitution: boolean
    readonly allRedirectsAreDevNull?: boolean
    readonly executableCommands: readonly {
      readonly name: string
      readonly fullText: string
      readonly args: readonly { readonly type: string; readonly value: string }[]
    }[]
    readonly redirects: readonly {
      readonly operator: string
      readonly destinationFds: readonly number[]
      readonly targetNodeType: string
      readonly targetText?: string
    }[]
  }
  readonly requestedSandboxPolicy?: ShellSandboxPolicy
  readonly isBackground: boolean
  readonly skipApproval: boolean
  readonly timeoutBehavior: ShellTimeoutBehaviorInterop
  readonly hardTimeout?: number
  readonly description?: string
  readonly adminCommandDenylist: readonly string[]
}): ShellArgsInterop {
  return new ShellArgs({
    command: input.command,
    workingDirectory: input.workingDirectory,
    timeout: input.timeout,
    toolCallId: input.toolCallId,
    simpleCommands: [...input.simpleCommands],
    hasInputRedirect: input.hasInputRedirect,
    hasOutputRedirect: input.hasOutputRedirect,
    parsingResult: new ShellCommandParsingResult({
      parsingFailed: input.parsingResult.parsingFailed,
      hasRedirects: input.parsingResult.hasRedirects,
      hasCommandSubstitution: input.parsingResult.hasCommandSubstitution,
      ...(input.parsingResult.allRedirectsAreDevNull === undefined ? {} : { allRedirectsAreDevNull: input.parsingResult.allRedirectsAreDevNull }),
      executableCommands: input.parsingResult.executableCommands.map((command) => new ShellCommandParsingResult_ExecutableCommand({
        name: command.name,
        fullText: command.fullText,
        args: command.args.map((argument) => new ShellCommandParsingResult_ExecutableCommandArg({ type: argument.type, value: argument.value })),
      })),
      redirects: input.parsingResult.redirects.map((redirect) => new ShellCommandParsingResult_Redirect({
        operator: redirect.operator,
        destinationFds: [...redirect.destinationFds],
        targetNodeType: redirect.targetNodeType,
        ...(redirect.targetText === undefined ? {} : { targetText: redirect.targetText }),
      })),
    }),
    ...(input.requestedSandboxPolicy === undefined ? {} : { requestedSandboxPolicy: createShellSandboxPolicyInterop(input.requestedSandboxPolicy) }),
    isBackground: input.isBackground,
    skipApproval: input.skipApproval,
    timeoutBehavior: TimeoutBehavior.BACKGROUND,
    ...(input.hardTimeout === undefined ? {} : { hardTimeout: input.hardTimeout }),
    ...(input.description === undefined ? {} : { description: input.description }),
    closeStdin: false,
    adminCommandDenylist: [...input.adminCommandDenylist],
  })
}

export function emptyShellArgsInterop(): ShellArgsInterop {
  return new ShellArgs()
}

export function projectShellStreamEventInterop(stream: ShellStream): ShellStreamEventViewInterop {
  const event = stream.event
  switch (event.case) {
    case "stdout":
    case "stderr":
      return { kind: event.case, data: event.value.data }
    case "exit":
      return {
        kind: "exit",
        code: event.value.code,
        aborted: event.value.aborted,
        ...(event.value.localExecutionTimeMs === undefined ? {} : { localExecutionTimeMs: event.value.localExecutionTimeMs }),
        ...(event.value.outputLocation === undefined ? {} : { outputLocation: event.value.outputLocation }),
        ...(event.value.abortReason === undefined ? {} : { abortReason: event.value.abortReason }),
      }
    case "rejected":
      return { kind: "rejected", command: event.value.command, workingDirectory: event.value.workingDirectory, reason: event.value.reason }
    case "permissionDenied":
      return { kind: "permission-denied", command: event.value.command, workingDirectory: event.value.workingDirectory, error: event.value.error, isReadonly: event.value.isReadonly }
    case "sandboxUnsupported":
      return { kind: "sandbox-unsupported", reason: event.value.reason }
    case "backgrounded":
      return {
        kind: "backgrounded",
        command: event.value.command,
        workingDirectory: event.value.workingDirectory,
        shellId: event.value.shellId,
        ...(event.value.pid === undefined ? {} : { pid: event.value.pid }),
        ...(event.value.msToWait === undefined ? {} : { msToWait: event.value.msToWait }),
        ...(event.value.reason === undefined ? {} : { reason: event.value.reason }),
      }
    default:
      return { kind: "other" }
  }
}

export function createShellStreamResultInterop(input: {
  readonly command: string
  readonly workingDirectory: string
  readonly stdout: string
  readonly stderr: string
  readonly interleavedOutput: string
  readonly exit: Extract<ShellStreamEventViewInterop, { readonly kind: "exit" }>
  readonly sandboxPolicy?: ShellSandboxPolicy
}): ShellResultInterop {
  const success = input.exit.code === 0 && !input.exit.aborted
  const base = {
    command: input.command,
    workingDirectory: input.workingDirectory,
    exitCode: input.exit.code,
    signal: input.exit.aborted ? "SIGTERM" : "",
    stdout: input.stdout,
    stderr: input.stderr,
    executionTime: input.exit.localExecutionTimeMs ?? 0,
    interleavedOutput: input.interleavedOutput,
    ...(input.exit.outputLocation === undefined ? {} : { outputLocation: input.exit.outputLocation as never }),
    ...(input.exit.abortReason === undefined ? {} : { abortReason: input.exit.abortReason as never }),
    ...(input.exit.aborted ? { aborted: true } : {}),
  }
  return new ShellResult({
    result: success
      ? { case: "success", value: new ShellSuccess(base) }
      : { case: "failure", value: new ShellFailure(base) },
    ...(input.sandboxPolicy === undefined ? {} : { sandboxPolicy: createShellSandboxPolicyInterop(input.sandboxPolicy) }),
  })
}

export function createBackgroundShellSuccessInterop(input: {
  readonly command: string
  readonly workingDirectory: string
  readonly shellId: number
  readonly pid?: number
  readonly msToWait?: number
  readonly reason?: number
  readonly stdout: string
  readonly stderr: string
  readonly interleavedOutput: string
  readonly sandboxPolicy?: ShellSandboxPolicy
}): ShellResultInterop {
  return new ShellResult({
    result: {
      case: "success",
      value: new ShellSuccess({
        command: input.command,
        workingDirectory: input.workingDirectory,
        shellId: input.shellId,
        ...(input.pid === undefined ? {} : { pid: input.pid }),
        ...(input.msToWait === undefined ? {} : { msToWait: input.msToWait }),
        ...(input.reason === undefined ? {} : { backgroundReason: input.reason as never }),
        stdout: input.stdout,
        stderr: input.stderr,
        interleavedOutput: input.interleavedOutput,
        executionTime: 0,
      }),
    },
    isBackground: true,
    ...(input.sandboxPolicy === undefined ? {} : { sandboxPolicy: createShellSandboxPolicyInterop(input.sandboxPolicy) }),
  })
}

export function createShellToolCallInterop(input: {
  readonly args?: ShellArgsInterop
  readonly result?: ShellResultInterop
}): ShellToolEnvelopeInterop {
  return new ToolCall({
    tool: {
      case: "shellToolCall",
      value: new ShellToolCall({
        ...(input.args === undefined ? {} : { args: input.args }),
        ...(input.result === undefined ? {} : { result: input.result }),
      }),
    },
  })
}

export function createShellFailureToolCallInterop(input:
  | { readonly kind: "rejected"; readonly command: string; readonly workingDirectory: string; readonly reason: string }
  | { readonly kind: "permission-denied"; readonly command: string; readonly workingDirectory: string; readonly error: string; readonly isReadonly: boolean }
  | { readonly kind: "timeout"; readonly command: string; readonly workingDirectory: string; readonly timeoutMs: number }
  | { readonly kind: "spawn-error"; readonly error: string }
): ShellToolEnvelopeInterop {
  const result = input.kind === "rejected"
    ? { case: "rejected" as const, value: new ShellRejected({ command: input.command, workingDirectory: input.workingDirectory, reason: input.reason }) }
    : input.kind === "permission-denied"
      ? { case: "permissionDenied" as const, value: new ShellPermissionDenied({ command: input.command, workingDirectory: input.workingDirectory, error: input.error, isReadonly: input.isReadonly }) }
      : input.kind === "timeout"
        ? { case: "timeout" as const, value: new ShellTimeout({ command: input.command, workingDirectory: input.workingDirectory, timeoutMs: input.timeoutMs }) }
        : { case: "spawnError" as const, value: new ShellSpawnError({ error: input.error }) }
  return createShellToolCallInterop({ result: new ShellResult({ result }) })
}

export function formatShellResultInterop(result: ShellResultInterop, input: {
  readonly terminalsFolder?: string
  readonly promptVersion?: string
  readonly sandboxPromptEnabled?: boolean
  readonly useMinimalHarness?: boolean
}): string {
  return renderInteropShellResultToString({
    result: result.result,
    sandboxPolicy: result.sandboxPolicy,
    isBackground: result.isBackground,
    terminalsFolder: input.terminalsFolder,
  }, {
    ...(input.promptVersion === undefined ? {} : { promptVersion: input.promptVersion }),
    ...(input.sandboxPromptEnabled === undefined ? {} : { sandboxPromptEnabled: input.sandboxPromptEnabled }),
    ...(input.useMinimalHarness === undefined ? {} : { useMinimalHarness: input.useMinimalHarness }),
  })
}

function toJsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {}
  for (const [key, entry] of Object.entries(value)) {
    const json = toJsonValue(entry)
    if (json !== undefined) result[key] = json
  }
  return result
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value
  if (Array.isArray(value)) {
    const values = value.map(toJsonValue)
    return values.some((item) => item === undefined) ? undefined : values as JsonValue[]
  }
  if (typeof value === "object") return toJsonRecord(value as Record<string, unknown>)
  return undefined
}
