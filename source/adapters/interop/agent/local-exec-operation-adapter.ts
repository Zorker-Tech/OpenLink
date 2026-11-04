/** Projects the owned local-exec read operation to and from the generated executor envelope. */
import type { JsonValue } from "@bufbuild/protobuf";

import {
  ExecClientMessage,
  ExecServerMessage,
  SpanContext,
} from "../proto/generated/agent/v1/exec_pb.ts";
import { HookAdditionalContext } from "../proto/generated/agent/v1/hook_additional_context_pb.ts";
import {
  ReadArgs,
  ReadResult,
} from "../proto/generated/agent/v1/read_exec_pb.ts";
import {
  LsArgs,
  LsDirectoryTreeNode,
  LsDirectoryTreeNode_File,
  LsError,
  LsRejected,
  LsResult,
  LsSuccess,
  LsTimeout,
  TerminalMetadata,
} from "../proto/generated/agent/v1/ls_exec_pb.ts";
import {
  BackgroundShellSpawnArgs,
  BackgroundShellSpawnError,
  BackgroundShellSpawnResult,
  BackgroundShellSpawnSuccess,
} from "../proto/generated/agent/v1/background_shell_exec_pb.ts";
import {
  CommandClassifierResult,
  ShellAbortReason,
  ShellArgs,
  ShellBackgroundReason,
  ShellCommandParsingResult,
  ShellHookApprovalRequirement,
  ShellOutputNotificationConfig,
  ShellPermissionDenied,
  ShellRejected,
  ShellSandboxUnsupported,
  ShellStream,
  ShellStreamBackgrounded,
  ShellStreamExit,
  ShellStreamHookContext,
  ShellStreamStart,
  ShellStreamStderr,
  ShellStreamStdout,
  TimeoutBehavior,
} from "../proto/generated/agent/v1/shell_exec_pb.ts";
import { OutputLocation, SmartModeApproval } from "../proto/generated/agent/v1/utils_pb.ts";
import { localReadOutcomeToInterop } from "./local-read-executor-adapter.ts";
import {
  adaptSandboxPolicyFromInterop,
  adaptSandboxPolicyToInterop,
  adaptSandboxPolicyValueFromInterop,
} from "./sandbox-policy-adapter.ts";
import type { LocalReadOutcome } from "../../../packages/local-exec/read.ts";
import type { SandboxRule } from "../../../packages/local-exec/sandbox-policy.ts";
import { jsonValueSchema } from "@slate/work-domain";
import {
  SLATE_LOCAL_EXEC_OPERATION_SCHEMA,
  parseLocalExecBackgroundSpawnResult,
  parseLocalExecListResult,
  parseLocalExecShellResult,
  parseLocalExecReadResult,
  type LocalExecReadRequest,
  type LocalExecReadResult,
  type LocalExecBackgroundSpawnRequest,
  type LocalExecBackgroundSpawnResult,
  type LocalExecDirectoryNode,
  type LocalExecListRequest,
  type LocalExecListResult,
  type LocalExecShellRequest,
  type LocalExecShellResult,
} from "../../../shared/local-exec-protocol.ts";

function toProtobufJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

type WireSandboxRule = NonNullable<LocalExecShellRequest["args"]["requestedSandboxPolicy"]>;

function sandboxRuleForWire(value: SandboxRule): WireSandboxRule {
  const ignoreMapping = jsonValueSchema.safeParse(value.ignoreMapping);
  return {
    type: value.type,
    ...(value.networkPolicy === undefined ? {} : { networkPolicy: value.networkPolicy }),
    ...(value.skipStatsigDefaults === undefined ? {} : { skipStatsigDefaults: value.skipStatsigDefaults }),
    ...(value.additionalReadwritePaths === undefined
      ? {}
      : { additionalReadwritePaths: value.additionalReadwritePaths }),
    ...(value.additionalReadonlyPaths === undefined
      ? {}
      : { additionalReadonlyPaths: value.additionalReadonlyPaths }),
    ...(value.disableTmpWrite === undefined ? {} : { disableTmpWrite: value.disableTmpWrite }),
    ...(value.enableSharedBuildCache === undefined ? {} : { enableSharedBuildCache: value.enableSharedBuildCache }),
    ...(value.debugOutputDir === undefined ? {} : { debugOutputDir: value.debugOutputDir }),
    ...(value.captureDenies === undefined ? {} : { captureDenies: value.captureDenies }),
    ...(value.networkPolicyStrict === undefined ? {} : { networkPolicyStrict: value.networkPolicyStrict }),
    ...(value.readBoundary === undefined ? {} : { readBoundary: value.readBoundary }),
    ...(value.additionalReadPaths === undefined ? {} : { additionalReadPaths: value.additionalReadPaths }),
    ...(value.allowlistEscalated === undefined ? {} : { allowlistEscalated: value.allowlistEscalated }),
    ...(!ignoreMapping.success ? {} : { ignoreMapping: ignoreMapping.data }),
  };
}

function optionalExecId(value: string | undefined): { readonly execId?: string } {
  return value === undefined || value.length === 0 ? {} : { execId: value };
}

function traceOf(message: ExecServerMessage): LocalExecReadRequest["trace"] {
  if (message.spanContext === undefined) return undefined;
  return {
    traceId: message.spanContext.traceId,
    spanId: message.spanContext.spanId,
    ...(message.spanContext.traceFlags === undefined ? {} : { traceFlags: message.spanContext.traceFlags }),
    ...(message.spanContext.traceState === undefined ? {} : { traceState: message.spanContext.traceState }),
  };
}

function spanOf(trace: LocalExecReadRequest["trace"]): SpanContext | undefined {
  if (trace === undefined) return undefined;
  return new SpanContext({
    traceId: trace.traceId,
    spanId: trace.spanId,
    ...(trace.traceFlags === undefined ? {} : { traceFlags: trace.traceFlags }),
    ...(trace.traceState === undefined ? {} : { traceState: trace.traceState }),
  });
}

/** Converts a generated read request into the Slate wire form; other operations stay on their compatibility path. */
export function slateReadRequestFromInterop(message: ExecServerMessage): LocalExecReadRequest | undefined {
  const redacted = message.message.case === "redactedReadArgs";
  if (!redacted && message.message.case !== "readArgs") return undefined;
  const value = message.message.value;
  if (!(value instanceof ReadArgs) || value.path.length === 0) return undefined;
  const trace = traceOf(message);
  return {
    schema: SLATE_LOCAL_EXEC_OPERATION_SCHEMA,
    id: message.id,
    ...optionalExecId(message.execId),
    ...(message.acceptHookAdditionalContexts === undefined
      ? {}
      : { acceptHookAdditionalContexts: message.acceptHookAdditionalContexts }),
    ...(trace === undefined ? {} : { trace }),
    op: "workspace.read",
    redacted,
    args: {
      path: value.path,
      ...(value.toolCallId.length === 0 ? {} : { toolCallId: value.toolCallId }),
      ...(value.offset === undefined ? {} : { offset: value.offset }),
      ...(value.limit === undefined ? {} : { limit: value.limit }),
      ...(value.encodingHint === undefined ? {} : { encodingHint: value.encodingHint }),
    },
  };
}

/** Reconstructs the generated request consumed inside the existing daemon registry. */
export function slateReadRequestToInterop(request: LocalExecReadRequest): ExecServerMessage {
  const caseName = request.redacted ? "redactedReadArgs" : "readArgs";
  const spanContext = spanOf(request.trace);
  return new ExecServerMessage({
    id: request.id,
    ...(request.execId === undefined ? {} : { execId: request.execId }),
    ...(spanContext === undefined ? {} : { spanContext }),
    ...(request.acceptHookAdditionalContexts === undefined
      ? {}
      : { acceptHookAdditionalContexts: request.acceptHookAdditionalContexts }),
    message: {
      case: caseName,
      value: new ReadArgs({
        path: request.args.path,
        ...(request.args.toolCallId === undefined ? {} : { toolCallId: request.args.toolCallId }),
        ...(request.args.offset === undefined ? {} : { offset: request.args.offset }),
        ...(request.args.limit === undefined ? {} : { limit: request.args.limit }),
        ...(request.args.encodingHint === undefined ? {} : { encodingHint: request.args.encodingHint }),
      }),
    },
  });
}

/** Projects one generated read result into the Slate result value carried by the provider response. */
export function slateReadResultFromInterop(message: ExecClientMessage): LocalExecReadResult | undefined {
  const redacted = message.message.case === "redactedReadResult";
  if (!redacted && message.message.case !== "readResult") return undefined;
  const value = message.message.value;
  if (!(value instanceof ReadResult)) return undefined;
  let result: LocalExecReadResult["result"];
  switch (value.result.case) {
    case "success":
      result = {
        kind: "success",
        path: value.result.value.path,
        body: value.result.value.output.case === "data"
          ? { kind: "bytes", base64: Buffer.from(value.result.value.output.value).toString("base64") }
          : { kind: "text", text: value.result.value.output.value ?? "" },
        totalLines: value.result.value.totalLines,
        fileSize: value.result.value.fileSize.toString(),
        truncated: value.result.value.truncated,
        rangeApplied: value.result.value.rangeApplied,
      };
      break;
    case "invalidFile":
      result = { kind: "invalid-file", path: value.result.value.path, reason: value.result.value.reason };
      break;
    case "permissionDenied":
      result = { kind: "permission-denied", path: value.result.value.path };
      break;
    case "fileNotFound":
      result = { kind: "not-found", path: value.result.value.path };
      break;
    case "error":
      result = { kind: "error", path: value.result.value.path, error: value.result.value.error };
      break;
    default:
      return undefined;
  }
  const trace = optionalExecId(message.execId);
  return {
    schema: SLATE_LOCAL_EXEC_OPERATION_SCHEMA,
    id: message.id,
    ...trace,
    ...(message.localExecutionTimeMs === undefined ? {} : { localExecutionTimeMs: message.localExecutionTimeMs }),
    ...(message.hookAdditionalContexts.length === 0
      ? {}
      : { additionalContexts: message.hookAdditionalContexts.map((context) => toProtobufJson(context.toJson())) }),
    op: "workspace.read.result",
    redacted,
    result,
  };
}

function readOutcomeFromSlate(result: LocalExecReadResult): LocalReadOutcome {
  switch (result.result.kind) {
    case "success":
      return {
        kind: "success",
        path: result.result.path,
        output: result.result.body.kind === "bytes"
          ? { kind: "data", bytes: Buffer.from(result.result.body.base64, "base64") }
          : { kind: "text", text: result.result.body.text },
        totalLines: result.result.totalLines,
        fileSize: Number(BigInt(result.result.fileSize)),
        truncated: result.result.truncated,
        rangeApplied: result.result.rangeApplied,
      };
    case "invalid-file":
      return { kind: "invalid_file", path: result.result.path, reason: result.result.reason };
    case "permission-denied":
      return { kind: "permission_denied", path: result.result.path };
    case "not-found":
      return { kind: "not_found", path: result.result.path };
    case "error":
      return { kind: "error", path: result.result.path, error: result.result.error };
  }
}

/** Restores the generated response the existing resource accessor consumes. */
export function slateReadResultToInterop(value: unknown): ExecClientMessage | undefined {
  const slate = parseLocalExecReadResult(value);
  if (slate === undefined) return undefined;
  const result = localReadOutcomeToInterop(readOutcomeFromSlate(slate));
  const caseName = slate.redacted ? "redactedReadResult" : "readResult";
  return new ExecClientMessage({
    id: slate.id,
    ...(slate.execId === undefined ? {} : { execId: slate.execId }),
    ...(slate.localExecutionTimeMs === undefined ? {} : { localExecutionTimeMs: slate.localExecutionTimeMs }),
    ...(slate.additionalContexts === undefined
      ? {}
      : {
          hookAdditionalContexts: slate.additionalContexts.map((context) =>
            HookAdditionalContext.fromJson(toProtobufJson(context))
          ),
        }),
    message: { case: caseName, value: result },
  });
}

function shellArgsFromInterop(args: ShellArgs): LocalExecShellRequest["args"] {
  const policy = args.requestedSandboxPolicy === undefined
    ? undefined
    : adaptSandboxPolicyFromInterop(args.requestedSandboxPolicy);
  return {
    command: args.command,
    ...(args.workingDirectory.length === 0 ? {} : { workingDirectory: args.workingDirectory }),
    ...(args.toolCallId.length === 0 ? {} : { toolCallId: args.toolCallId }),
    ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
    ...(policy === undefined ? {} : { requestedSandboxPolicy: sandboxRuleForWire(policy) }),
    ...(args.closeStdin ? { closeStdin: true } : {}),
    ...(args.timeout === 0 ? {} : { timeout: args.timeout }),
    ...(args.timeoutBehavior === TimeoutBehavior.BACKGROUND
      ? { timeoutBehavior: "background" as const }
      : args.timeoutBehavior === TimeoutBehavior.CANCEL
        ? { timeoutBehavior: "foreground" as const }
        : {}),
    ...(args.hardTimeout === undefined ? {} : { hardTimeout: args.hardTimeout }),
    ...(args.fileOutputThresholdBytes === undefined
      ? {}
      : { fileOutputThresholdBytes: args.fileOutputThresholdBytes.toString() }),
    ...(args.adminCommandDenylist.length === 0 ? {} : { adminCommandDenylist: [...args.adminCommandDenylist] }),
    ...(args.skipApproval ? { skipApproval: true } : {}),
    ...(args.smartModeApproval === undefined
      ? {}
      : {
          smartModeApproval: {
            ...(args.smartModeApproval.reason === undefined ? {} : { reason: args.smartModeApproval.reason }),
            ...(args.smartModeApproval.requestId === undefined ? {} : { requestId: args.smartModeApproval.requestId }),
          },
        }),
    ...(args.classifierResult === undefined ? {} : { classifierResult: args.classifierResult.toJson() }),
    ...(args.description === undefined ? {} : { description: args.description }),
    ...(args.outputNotification === undefined ? {} : { outputNotification: args.outputNotification.toJson() }),
    ...(args.hookApprovalRequirement === undefined
      ? {}
      : { hookApprovalRequirement: args.hookApprovalRequirement.toJson() }),
    ...(args.isBackground ? { isBackground: true } : {}),
    ...(args.simpleCommands.length === 0 ? {} : { simpleCommands: [...args.simpleCommands] }),
    ...(args.hasInputRedirect ? { hasInputRedirect: true } : {}),
    ...(args.hasOutputRedirect ? { hasOutputRedirect: true } : {}),
    ...(args.parsingResult === undefined ? {} : { parsingResult: args.parsingResult.toJson() }),
  };
}

function shellArgsToInterop(args: LocalExecShellRequest["args"]): ShellArgs {
  const requestedSandboxPolicy = args.requestedSandboxPolicy === undefined
    ? undefined
    : adaptSandboxPolicyToInterop(args.requestedSandboxPolicy);
  return new ShellArgs({
    command: args.command,
    ...(args.workingDirectory === undefined ? {} : { workingDirectory: args.workingDirectory }),
    ...(args.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }),
    ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
    ...(requestedSandboxPolicy === undefined ? {} : { requestedSandboxPolicy }),
    ...(args.closeStdin === undefined ? {} : { closeStdin: args.closeStdin }),
    ...(args.timeout === undefined ? {} : { timeout: args.timeout }),
    ...(args.timeoutBehavior === undefined
      ? {}
      : {
          timeoutBehavior: args.timeoutBehavior === "background"
            ? TimeoutBehavior.BACKGROUND
            : TimeoutBehavior.CANCEL,
        }),
    ...(args.hardTimeout === undefined ? {} : { hardTimeout: args.hardTimeout }),
    ...(args.fileOutputThresholdBytes === undefined
      ? {}
      : { fileOutputThresholdBytes: BigInt(args.fileOutputThresholdBytes) }),
    ...(args.adminCommandDenylist === undefined ? {} : { adminCommandDenylist: [...args.adminCommandDenylist] }),
    ...(args.skipApproval === undefined ? {} : { skipApproval: args.skipApproval }),
    ...(args.smartModeApproval === undefined
      ? {}
      : {
          smartModeApproval: new SmartModeApproval({
            ...(args.smartModeApproval.reason === undefined ? {} : { reason: args.smartModeApproval.reason }),
            ...(args.smartModeApproval.requestId === undefined ? {} : { requestId: args.smartModeApproval.requestId }),
          }),
        }),
    ...(args.classifierResult === undefined
      ? {}
      : { classifierResult: CommandClassifierResult.fromJson(toProtobufJson(args.classifierResult)) }),
    ...(args.description === undefined ? {} : { description: args.description }),
    ...(args.outputNotification === undefined
      ? {}
      : { outputNotification: ShellOutputNotificationConfig.fromJson(toProtobufJson(args.outputNotification)) }),
    ...(args.hookApprovalRequirement === undefined
      ? {}
      : {
          hookApprovalRequirement: ShellHookApprovalRequirement.fromJson(
            toProtobufJson(args.hookApprovalRequirement),
          ),
        }),
    ...(args.isBackground === undefined ? {} : { isBackground: args.isBackground }),
    ...(args.simpleCommands === undefined ? {} : { simpleCommands: [...args.simpleCommands] }),
    ...(args.hasInputRedirect === undefined ? {} : { hasInputRedirect: args.hasInputRedirect }),
    ...(args.hasOutputRedirect === undefined ? {} : { hasOutputRedirect: args.hasOutputRedirect }),
    ...(args.parsingResult === undefined
      ? {}
      : { parsingResult: ShellCommandParsingResult.fromJson(toProtobufJson(args.parsingResult)) }),
  });
}

/** Converts the generated shell stream request into the Slate wire form. */
export function slateShellRequestFromInterop(message: ExecServerMessage): LocalExecShellRequest | undefined {
  if (message.message.case !== "shellStreamArgs") return undefined;
  const value = message.message.value;
  if (!(value instanceof ShellArgs)) return undefined;
  const trace = traceOf(message);
  return {
    schema: SLATE_LOCAL_EXEC_OPERATION_SCHEMA,
    id: message.id,
    ...optionalExecId(message.execId),
    ...(message.acceptHookAdditionalContexts === undefined
      ? {}
      : { acceptHookAdditionalContexts: message.acceptHookAdditionalContexts }),
    ...(trace === undefined ? {} : { trace }),
    op: "shell.stream",
    args: shellArgsFromInterop(value),
  };
}

/** Reconstructs the generated shell request consumed by the existing controlled manager. */
export function slateShellRequestToInterop(request: LocalExecShellRequest): ExecServerMessage {
  const spanContext = spanOf(request.trace);
  return new ExecServerMessage({
    id: request.id,
    ...(request.execId === undefined ? {} : { execId: request.execId }),
    ...(spanContext === undefined ? {} : { spanContext }),
    ...(request.acceptHookAdditionalContexts === undefined
      ? {}
      : { acceptHookAdditionalContexts: request.acceptHookAdditionalContexts }),
    message: { case: "shellStreamArgs", value: shellArgsToInterop(request.args) },
  });
}

function shellEventFromInterop(event: ShellStream["event"]): LocalExecShellResult["event"] | undefined {
  switch (event.case) {
    case "rejected":
      return {
        kind: "rejected",
        command: event.value.command,
        workingDirectory: event.value.workingDirectory,
        reason: event.value.reason,
        ...(event.value.isReadonly ? { isReadonly: true } : {}),
      };
    case "permissionDenied":
      return {
        kind: "permission-denied",
        command: event.value.command,
        workingDirectory: event.value.workingDirectory,
        error: event.value.error,
        isReadonly: event.value.isReadonly,
      };
    case "start":
      return {
        kind: "start",
        ...(event.value.sandboxPolicy === undefined
          ? {}
          : { policy: sandboxRuleForWire(adaptSandboxPolicyValueFromInterop(event.value.sandboxPolicy)) }),
      };
    case "stdout":
      return { kind: "stdout", data: event.value.data };
    case "stderr":
      return { kind: "stderr", data: event.value.data };
    case "exit":
      return {
        kind: "exit",
        code: event.value.code,
        cwd: event.value.cwd,
        ...(event.value.outputLocation === undefined
          ? {}
          : {
              outputLocation: {
                filePath: event.value.outputLocation.filePath,
                sizeBytes: event.value.outputLocation.sizeBytes.toString(),
                lineCount: event.value.outputLocation.lineCount.toString(),
              },
            }),
        aborted: event.value.aborted,
        ...(event.value.abortReason === ShellAbortReason.USER_ABORT
          ? { abortReason: "user-abort" as const }
          : event.value.abortReason === ShellAbortReason.TIMEOUT
            ? { abortReason: "timeout" as const }
            : {}),
        ...(event.value.localExecutionTimeMs === undefined
          ? {}
          : { localExecutionTimeMs: event.value.localExecutionTimeMs }),
      };
    case "sandboxUnsupported":
      return {
        kind: "sandbox-unsupported",
        command: event.value.command,
        workingDirectory: event.value.workingDirectory,
        policyType: event.value.sandboxPolicyType,
        reason: event.value.reason,
        readonly: event.value.isReadonly,
      };
    case "backgrounded":
      return {
        kind: "backgrounded",
        shellId: event.value.shellId,
        command: event.value.command,
        workingDirectory: event.value.workingDirectory,
        ...(event.value.pid === undefined ? {} : { pid: event.value.pid }),
        elapsedMs: event.value.msToWait ?? 0,
        reason: event.value.reason === ShellBackgroundReason.USER_REQUEST
          ? "user"
          : event.value.reason === ShellBackgroundReason.TIMEOUT
            ? "timeout"
            : "unspecified",
      };
    case "hookContext":
      return {
        kind: "hook-context",
        contexts: event.value.hookAdditionalContexts.map((context) => context.toJson()),
      };
    default:
      return undefined;
  }
}

function shellEventToInterop(event: LocalExecShellResult["event"]): ShellStream["event"] {
  switch (event.kind) {
    case "rejected":
      return {
        case: "rejected",
        value: new ShellRejected({
          command: event.command,
          workingDirectory: event.workingDirectory,
          reason: event.reason,
          ...(event.isReadonly === undefined ? {} : { isReadonly: event.isReadonly }),
        }),
      };
    case "permission-denied":
      return {
        case: "permissionDenied",
        value: new ShellPermissionDenied({
          command: event.command,
          workingDirectory: event.workingDirectory,
          error: event.error,
          isReadonly: event.isReadonly,
        }),
      };
    case "start":
      {
        const sandboxPolicy = event.policy === undefined
          ? undefined
          : adaptSandboxPolicyToInterop(event.policy);
      return {
        case: "start",
        value: new ShellStreamStart(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
      };
      }
    case "stdout":
      return { case: "stdout", value: new ShellStreamStdout({ data: event.data }) };
    case "stderr":
      return { case: "stderr", value: new ShellStreamStderr({ data: event.data }) };
    case "exit":
      return {
        case: "exit",
        value: new ShellStreamExit({
          code: event.code,
          cwd: event.cwd,
          ...(event.outputLocation === undefined
            ? {}
            : {
                outputLocation: new OutputLocation({
                  filePath: event.outputLocation.filePath,
                  sizeBytes: BigInt(event.outputLocation.sizeBytes),
                  lineCount: BigInt(event.outputLocation.lineCount),
                }),
              }),
          aborted: event.aborted,
          ...(event.abortReason === "user-abort"
            ? { abortReason: ShellAbortReason.USER_ABORT }
            : event.abortReason === "timeout"
              ? { abortReason: ShellAbortReason.TIMEOUT }
              : {}),
          ...(event.localExecutionTimeMs === undefined
            ? {}
            : { localExecutionTimeMs: event.localExecutionTimeMs }),
        }),
      };
    case "sandbox-unsupported":
      return {
        case: "sandboxUnsupported",
        value: new ShellSandboxUnsupported({
          command: event.command,
          workingDirectory: event.workingDirectory,
          sandboxPolicyType: event.policyType,
          reason: event.reason,
          isReadonly: event.readonly,
        }),
      };
    case "backgrounded":
      return {
        case: "backgrounded",
        value: new ShellStreamBackgrounded({
          shellId: event.shellId,
          command: event.command,
          workingDirectory: event.workingDirectory,
          ...(event.pid === undefined ? {} : { pid: event.pid }),
          msToWait: event.elapsedMs,
          reason: event.reason === "user"
            ? ShellBackgroundReason.USER_REQUEST
            : event.reason === "timeout"
              ? ShellBackgroundReason.TIMEOUT
              : ShellBackgroundReason.UNSPECIFIED,
        }),
      };
    case "hook-context":
      return {
        case: "hookContext",
        value: new ShellStreamHookContext({
          hookAdditionalContexts: event.contexts.map((context) =>
            HookAdditionalContext.fromJson(toProtobufJson(context))
          ),
        }),
      };
  }
}

/** Projects one generated shell event into the Slate result schema. */
export function slateShellResultFromInterop(message: ExecClientMessage): LocalExecShellResult | undefined {
  if (message.message.case !== "shellStream" || !(message.message.value instanceof ShellStream)) return undefined;
  const event = shellEventFromInterop(message.message.value.event);
  if (event === undefined) return undefined;
  return {
    schema: SLATE_LOCAL_EXEC_OPERATION_SCHEMA,
    id: message.id,
    ...optionalExecId(message.execId),
    ...(message.localExecutionTimeMs === undefined ? {} : { localExecutionTimeMs: message.localExecutionTimeMs }),
    ...(message.hookAdditionalContexts.length === 0
      ? {}
      : { additionalContexts: message.hookAdditionalContexts.map((context) => context.toJson()) }),
    op: "shell.stream.result",
    event,
  };
}

/** Restores the generated shell event consumed by the host resource accessor. */
export function slateShellResultToInterop(value: unknown): ExecClientMessage | undefined {
  const parsed = parseLocalExecShellResult(value);
  if (parsed === undefined) return undefined;
  const stream = new ShellStream({ event: shellEventToInterop(parsed.event) });
  return new ExecClientMessage({
    id: parsed.id,
    ...(parsed.execId === undefined ? {} : { execId: parsed.execId }),
    ...(parsed.localExecutionTimeMs === undefined ? {} : { localExecutionTimeMs: parsed.localExecutionTimeMs }),
    ...(parsed.additionalContexts === undefined
      ? {}
      : {
          hookAdditionalContexts: parsed.additionalContexts.map((context) =>
            HookAdditionalContext.fromJson(toProtobufJson(context))
          ),
        }),
    message: { case: "shellStream", value: stream },
  });
}

/** Converts a generated directory request into the Slate wire form. */
export function slateListRequestFromInterop(message: ExecServerMessage): LocalExecListRequest | undefined {
  if (message.message.case !== "lsArgs") return undefined;
  const value = message.message.value;
  if (!(value instanceof LsArgs)) return undefined;
  const trace = traceOf(message);
  const sandboxPolicy = value.sandboxPolicy === undefined
    ? undefined
    : sandboxRuleForWire(adaptSandboxPolicyFromInterop(value.sandboxPolicy));
  return {
    schema: SLATE_LOCAL_EXEC_OPERATION_SCHEMA,
    id: message.id,
    ...optionalExecId(message.execId),
    ...(message.acceptHookAdditionalContexts === undefined
      ? {}
      : { acceptHookAdditionalContexts: message.acceptHookAdditionalContexts }),
    ...(trace === undefined ? {} : { trace }),
    op: "workspace.list",
    args: {
      path: value.path,
      ...(value.ignore.length === 0 ? {} : { ignore: [...value.ignore] }),
      ...(value.toolCallId.length === 0 ? {} : { toolCallId: value.toolCallId }),
      ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
      ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
    },
  };
}

/** Reconstructs the generated directory request consumed by the existing registry. */
export function slateListRequestToInterop(request: LocalExecListRequest): ExecServerMessage {
  const spanContext = spanOf(request.trace);
  const sandboxPolicy = request.args.sandboxPolicy === undefined
    ? undefined
    : adaptSandboxPolicyToInterop(request.args.sandboxPolicy);
  return new ExecServerMessage({
    id: request.id,
    ...(request.execId === undefined ? {} : { execId: request.execId }),
    ...(spanContext === undefined ? {} : { spanContext }),
    ...(request.acceptHookAdditionalContexts === undefined
      ? {}
      : { acceptHookAdditionalContexts: request.acceptHookAdditionalContexts }),
    message: {
      case: "lsArgs",
      value: new LsArgs({
        path: request.args.path,
        ignore: [...(request.args.ignore ?? [])],
        toolCallId: request.args.toolCallId ?? "",
        ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
        ...(request.args.timeoutMs === undefined ? {} : { timeoutMs: request.args.timeoutMs }),
      }),
    },
  });
}

function directoryNodeFromInterop(value: LsDirectoryTreeNode): LocalExecDirectoryNode {
  return {
    path: value.absPath,
    directories: value.childrenDirs.map(directoryNodeFromInterop),
    files: value.childrenFiles.map((file) => ({
      name: file.name,
      ...(file.terminalMetadata === undefined ? {} : { terminalMetadata: file.terminalMetadata.toJson() }),
    })),
    processed: value.childrenWereProcessed,
    extensionCounts: { ...value.fullSubtreeExtensionCounts },
    numFiles: value.numFiles,
  };
}

function directoryNodeToInterop(value: LocalExecDirectoryNode): LsDirectoryTreeNode {
  return new LsDirectoryTreeNode({
    absPath: value.path,
    childrenDirs: value.directories.map(directoryNodeToInterop),
    childrenFiles: value.files.map((file) => new LsDirectoryTreeNode_File({
      name: file.name,
      ...(file.terminalMetadata === undefined
        ? {}
        : { terminalMetadata: TerminalMetadata.fromJson(toProtobufJson(file.terminalMetadata)) }),
    })),
    childrenWereProcessed: value.processed,
    fullSubtreeExtensionCounts: { ...value.extensionCounts },
    numFiles: value.numFiles,
  });
}

/** Projects one generated directory result into the Slate result schema. */
export function slateListResultFromInterop(message: ExecClientMessage): LocalExecListResult | undefined {
  if (message.message.case !== "lsResult" || !(message.message.value instanceof LsResult)) return undefined;
  const value = message.message.value;
  let result: LocalExecListResult["result"];
  switch (value.result.case) {
    case "success":
      result = {
        kind: "success",
        ...(value.result.value.directoryTreeRoot === undefined
          ? {}
          : { root: directoryNodeFromInterop(value.result.value.directoryTreeRoot) }),
      };
      break;
    case "error":
      result = { kind: "error", path: value.result.value.path, error: value.result.value.error };
      break;
    case "rejected":
      result = { kind: "rejected", path: value.result.value.path, reason: value.result.value.reason };
      break;
    case "timeout":
      result = {
        kind: "timeout",
        ...(value.result.value.directoryTreeRoot === undefined
          ? {}
          : { root: directoryNodeFromInterop(value.result.value.directoryTreeRoot) }),
      };
      break;
    default:
      return undefined;
  }
  return {
    schema: SLATE_LOCAL_EXEC_OPERATION_SCHEMA,
    id: message.id,
    ...optionalExecId(message.execId),
    ...(message.localExecutionTimeMs === undefined ? {} : { localExecutionTimeMs: message.localExecutionTimeMs }),
    ...(message.hookAdditionalContexts.length === 0
      ? {}
      : { additionalContexts: message.hookAdditionalContexts.map((context) => context.toJson()) }),
    op: "workspace.list.result",
    result,
  };
}

/** Restores the generated directory result consumed by the host resource accessor. */
export function slateListResultToInterop(value: unknown): ExecClientMessage | undefined {
  const parsed = parseLocalExecListResult(value);
  if (parsed === undefined) return undefined;
  let result: LsResult;
  switch (parsed.result.kind) {
    case "success":
      result = new LsResult({
        result: {
          case: "success",
          value: new LsSuccess({
            ...(parsed.result.root === undefined
              ? {}
              : { directoryTreeRoot: directoryNodeToInterop(parsed.result.root) }),
          }),
        },
      });
      break;
    case "error":
      result = new LsResult({
        result: {
          case: "error",
          value: new LsError({ path: parsed.result.path, error: parsed.result.error }),
        },
      });
      break;
    case "rejected":
      result = new LsResult({
        result: {
          case: "rejected",
          value: new LsRejected({ path: parsed.result.path, reason: parsed.result.reason }),
        },
      });
      break;
    case "timeout":
      result = new LsResult({
        result: {
          case: "timeout",
          value: new LsTimeout({
            ...(parsed.result.root === undefined
              ? {}
              : { directoryTreeRoot: directoryNodeToInterop(parsed.result.root) }),
          }),
        },
      });
      break;
  }
  return new ExecClientMessage({
    id: parsed.id,
    ...(parsed.execId === undefined ? {} : { execId: parsed.execId }),
    ...(parsed.localExecutionTimeMs === undefined ? {} : { localExecutionTimeMs: parsed.localExecutionTimeMs }),
    ...(parsed.additionalContexts === undefined
      ? {}
      : {
          hookAdditionalContexts: parsed.additionalContexts.map((context) =>
            HookAdditionalContext.fromJson(toProtobufJson(context))
          ),
        }),
    message: { case: "lsResult", value: result },
  });
}

function backgroundRequestFromInterop(value: BackgroundShellSpawnArgs): LocalExecBackgroundSpawnRequest["args"] {
  const sandboxPolicy = value.sandboxPolicy === undefined
    ? undefined
    : sandboxRuleForWire(adaptSandboxPolicyFromInterop(value.sandboxPolicy));
  return {
    command: value.command,
    ...(value.workingDirectory.length === 0 ? {} : { workingDirectory: value.workingDirectory }),
    ...(value.toolCallId.length === 0 ? {} : { toolCallId: value.toolCallId }),
    ...(value.conversationId === undefined ? {} : { conversationId: value.conversationId }),
    ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
    ...(value.adminCommandDenylist.length === 0 ? {} : { adminCommandDenylist: [...value.adminCommandDenylist] }),
    ...(value.enableWriteShellStdinTool ? { enableWriteShellStdinTool: true } : {}),
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.classifierResult === undefined ? {} : { classifierResult: value.classifierResult.toJson() }),
    ...(value.outputNotification === undefined ? {} : { outputNotification: value.outputNotification.toJson() }),
    ...(value.smartModeApproval === undefined
      ? {}
      : {
          smartModeApproval: {
            ...(value.smartModeApproval.reason === undefined ? {} : { reason: value.smartModeApproval.reason }),
            ...(value.smartModeApproval.requestId === undefined ? {} : { requestId: value.smartModeApproval.requestId }),
          },
        }),
    ...(value.hookApprovalRequirement === undefined
      ? {}
      : { hookApprovalRequirement: value.hookApprovalRequirement.toJson() }),
    ...(value.skipApproval ? { skipApproval: true } : {}),
    ...(value.parsingResult === undefined ? {} : { parsingResult: value.parsingResult.toJson() }),
  };
}

function backgroundRequestToInterop(args: LocalExecBackgroundSpawnRequest["args"]): BackgroundShellSpawnArgs {
  const sandboxPolicy = args.sandboxPolicy === undefined
    ? undefined
    : adaptSandboxPolicyToInterop(args.sandboxPolicy);
  return new BackgroundShellSpawnArgs({
    command: args.command,
    ...(args.workingDirectory === undefined ? {} : { workingDirectory: args.workingDirectory }),
    ...(args.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }),
    ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
    ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
    ...(args.adminCommandDenylist === undefined ? {} : { adminCommandDenylist: [...args.adminCommandDenylist] }),
    ...(args.enableWriteShellStdinTool === undefined
      ? {}
      : { enableWriteShellStdinTool: args.enableWriteShellStdinTool }),
    ...(args.description === undefined ? {} : { description: args.description }),
    ...(args.classifierResult === undefined
      ? {}
      : { classifierResult: CommandClassifierResult.fromJson(toProtobufJson(args.classifierResult)) }),
    ...(args.outputNotification === undefined
      ? {}
      : { outputNotification: ShellOutputNotificationConfig.fromJson(toProtobufJson(args.outputNotification)) }),
    ...(args.smartModeApproval === undefined
      ? {}
      : {
          smartModeApproval: new SmartModeApproval({
            ...(args.smartModeApproval.reason === undefined ? {} : { reason: args.smartModeApproval.reason }),
            ...(args.smartModeApproval.requestId === undefined ? {} : { requestId: args.smartModeApproval.requestId }),
          }),
        }),
    ...(args.hookApprovalRequirement === undefined
      ? {}
      : {
          hookApprovalRequirement: ShellHookApprovalRequirement.fromJson(
            toProtobufJson(args.hookApprovalRequirement),
          ),
        }),
    ...(args.skipApproval === undefined ? {} : { skipApproval: args.skipApproval }),
    ...(args.parsingResult === undefined
      ? {}
      : { parsingResult: ShellCommandParsingResult.fromJson(toProtobufJson(args.parsingResult)) }),
  });
}

/** Converts a generated background-shell request into the Slate wire form. */
export function slateBackgroundSpawnRequestFromInterop(
  message: ExecServerMessage,
): LocalExecBackgroundSpawnRequest | undefined {
  if (message.message.case !== "backgroundShellSpawnArgs") return undefined;
  const value = message.message.value;
  if (!(value instanceof BackgroundShellSpawnArgs)) return undefined;
  const trace = traceOf(message);
  return {
    schema: SLATE_LOCAL_EXEC_OPERATION_SCHEMA,
    id: message.id,
    ...optionalExecId(message.execId),
    ...(message.acceptHookAdditionalContexts === undefined
      ? {}
      : { acceptHookAdditionalContexts: message.acceptHookAdditionalContexts }),
    ...(trace === undefined ? {} : { trace }),
    op: "shell.background.spawn",
    args: backgroundRequestFromInterop(value),
  };
}

/** Reconstructs the generated background-shell request consumed by the existing registry. */
export function slateBackgroundSpawnRequestToInterop(
  request: LocalExecBackgroundSpawnRequest,
): ExecServerMessage {
  const spanContext = spanOf(request.trace);
  return new ExecServerMessage({
    id: request.id,
    ...(request.execId === undefined ? {} : { execId: request.execId }),
    ...(spanContext === undefined ? {} : { spanContext }),
    ...(request.acceptHookAdditionalContexts === undefined
      ? {}
      : { acceptHookAdditionalContexts: request.acceptHookAdditionalContexts }),
    message: {
      case: "backgroundShellSpawnArgs",
      value: backgroundRequestToInterop(request.args),
    },
  });
}

/** Projects a generated background-shell outcome into the Slate result schema. */
export function slateBackgroundSpawnResultFromInterop(
  message: ExecClientMessage,
): LocalExecBackgroundSpawnResult | undefined {
  if (
    message.message.case !== "backgroundShellSpawnResult"
    || !(message.message.value instanceof BackgroundShellSpawnResult)
  ) return undefined;
  const value = message.message.value;
  let result: LocalExecBackgroundSpawnResult["result"];
  switch (value.result.case) {
    case "success":
      result = {
        kind: "success",
        shellId: value.result.value.shellId,
        command: value.result.value.command,
        workingDirectory: value.result.value.workingDirectory,
        ...(value.result.value.pid === undefined ? {} : { pid: value.result.value.pid }),
      };
      break;
    case "rejected":
      result = {
        kind: "rejected",
        command: value.result.value.command,
        workingDirectory: value.result.value.workingDirectory,
        reason: value.result.value.reason,
      };
      break;
    case "permissionDenied":
      result = {
        kind: "permission-denied",
        command: value.result.value.command,
        workingDirectory: value.result.value.workingDirectory,
        error: value.result.value.error,
        isReadonly: value.result.value.isReadonly,
      };
      break;
    case "sandboxUnsupported":
      result = {
        kind: "sandbox-unsupported",
        command: value.result.value.command,
        workingDirectory: value.result.value.workingDirectory,
        policyType: value.result.value.sandboxPolicyType,
        reason: value.result.value.reason,
        isReadonly: value.result.value.isReadonly,
      };
      break;
    case "error":
      result = {
        kind: "error",
        command: value.result.value.command,
        workingDirectory: value.result.value.workingDirectory,
        error: value.result.value.error,
      };
      break;
    default:
      return undefined;
  }
  return {
    schema: SLATE_LOCAL_EXEC_OPERATION_SCHEMA,
    id: message.id,
    ...optionalExecId(message.execId),
    ...(message.localExecutionTimeMs === undefined ? {} : { localExecutionTimeMs: message.localExecutionTimeMs }),
    ...(message.hookAdditionalContexts.length === 0
      ? {}
      : { additionalContexts: message.hookAdditionalContexts.map((context) => context.toJson()) }),
    op: "shell.background.spawn.result",
    result,
  };
}

/** Restores the generated background-shell result consumed by the host resource accessor. */
export function slateBackgroundSpawnResultToInterop(value: unknown): ExecClientMessage | undefined {
  const parsed = parseLocalExecBackgroundSpawnResult(value);
  if (parsed === undefined) return undefined;
  let result: BackgroundShellSpawnResult;
  switch (parsed.result.kind) {
    case "success":
      result = new BackgroundShellSpawnResult({
        result: {
          case: "success",
          value: new BackgroundShellSpawnSuccess({
            shellId: parsed.result.shellId,
            command: parsed.result.command,
            workingDirectory: parsed.result.workingDirectory,
            ...(parsed.result.pid === undefined ? {} : { pid: parsed.result.pid }),
          }),
        },
      });
      break;
    case "rejected":
      result = new BackgroundShellSpawnResult({
        result: {
          case: "rejected",
          value: new ShellRejected({
            command: parsed.result.command,
            workingDirectory: parsed.result.workingDirectory,
            reason: parsed.result.reason,
          }),
        },
      });
      break;
    case "permission-denied":
      result = new BackgroundShellSpawnResult({
        result: {
          case: "permissionDenied",
          value: new ShellPermissionDenied({
            command: parsed.result.command,
            workingDirectory: parsed.result.workingDirectory,
            error: parsed.result.error,
            isReadonly: parsed.result.isReadonly,
          }),
        },
      });
      break;
    case "sandbox-unsupported":
      result = new BackgroundShellSpawnResult({
        result: {
          case: "sandboxUnsupported",
          value: new ShellSandboxUnsupported({
            command: parsed.result.command,
            workingDirectory: parsed.result.workingDirectory,
            sandboxPolicyType: parsed.result.policyType,
            reason: parsed.result.reason,
            isReadonly: parsed.result.isReadonly,
          }),
        },
      });
      break;
    case "error":
      result = new BackgroundShellSpawnResult({
        result: {
          case: "error",
          value: new BackgroundShellSpawnError({
            command: parsed.result.command,
            workingDirectory: parsed.result.workingDirectory,
            error: parsed.result.error,
          }),
        },
      });
      break;
  }
  return new ExecClientMessage({
    id: parsed.id,
    ...(parsed.execId === undefined ? {} : { execId: parsed.execId }),
    ...(parsed.localExecutionTimeMs === undefined ? {} : { localExecutionTimeMs: parsed.localExecutionTimeMs }),
    ...(parsed.additionalContexts === undefined
      ? {}
      : {
          hookAdditionalContexts: parsed.additionalContexts.map((context) =>
            HookAdditionalContext.fromJson(toProtobufJson(context))
          ),
        }),
    message: { case: "backgroundShellSpawnResult", value: result },
  });
}
