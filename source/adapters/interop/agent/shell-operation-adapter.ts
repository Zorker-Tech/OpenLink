/** Converts Slate command requests and outcomes at the executor transport edge. */

import {
  CommandClassifierResult,
  CommandClassifierResult_ClassifiedCommand,
  CommandClassifierResult_SuggestedSandboxMode,
  ShellAbortReason,
  ShellArgs,
  ShellBackgroundReason,
  ShellCommandParsingResult,
  ShellCommandParsingResult_ExecutableCommand,
  ShellCommandParsingResult_ExecutableCommandArg,
  ShellCommandParsingResult_Redirect,
  ShellFailure,
  ShellHookApprovalRequirement,
  ShellHookApprovalRequirement_Kind,
  ShellOutputNotificationConfig,
  ShellPermissionDenied,
  ShellRejected,
  ShellResult,
  ShellSpawnError,
  ShellSuccess,
  ShellTimeout,
  TimeoutBehavior,
  type ShellResult as InteropShellResult,
} from "../proto/generated/agent/v1/shell_exec_pb.ts";
import { OutputLocation, SmartModeApproval } from "../proto/generated/agent/v1/utils_pb.ts";
import type { ShellKnownOrUnknownReason, ShellCommandParsing, ShellExecResponse, ShellExecResult, ShellExecutor, ShellExecutorArgs, ShellOutputLocation } from "../../../packages/agent-exec/shell.ts";
import type { CommandClassifierInternalResult } from "../../../packages/agent/utils/agent-config-contracts.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";
import { adaptSandboxPolicyFromInterop, adaptSandboxPolicyToInterop } from "./sandbox-policy-adapter.ts";

type InteropShellArgs = ShellArgs;

function timeoutBehaviorFromInterop(value: number): ShellExecutorArgs["timeoutBehavior"] {
  switch (value) {
    case TimeoutBehavior.UNSPECIFIED: return undefined;
    case TimeoutBehavior.CANCEL: return "foreground";
    case TimeoutBehavior.BACKGROUND: return "background";
    default: return { kind: "unknown", code: value };
  }
}

function timeoutBehaviorToInterop(value: ShellExecutorArgs["timeoutBehavior"]): TimeoutBehavior {
  if (value === undefined) return TimeoutBehavior.UNSPECIFIED;
  if (value === "foreground") return TimeoutBehavior.CANCEL;
  if (value === "background") return TimeoutBehavior.BACKGROUND;
  return value.code as TimeoutBehavior;
}

function classifierResultFromInterop(value: CommandClassifierResult | undefined): CommandClassifierInternalResult | undefined {
  if (value === undefined) return undefined;
  if (value.classificationFailed) return { kind: "classification-failed" };
  const suggestedSandboxMode = (() => {
    switch (value.suggestedSandboxMode) {
      case CommandClassifierResult_SuggestedSandboxMode.SANDBOX: return "SANDBOX";
      case CommandClassifierResult_SuggestedSandboxMode.NO_SANDBOX: return "NO_SANDBOX";
      case CommandClassifierResult_SuggestedSandboxMode.UNDETERMINED:
      case CommandClassifierResult_SuggestedSandboxMode.UNSPECIFIED: return "UNDETERMINED";
      default: return `unknown-${value.suggestedSandboxMode}`;
    }
  })();
  return {
    kind: "classification-succeeded",
    suggestedSandboxMode,
    commands: value.commands.map(command => ({
      name: command.name,
      arguments: [...command.arguments],
      suggestedAllowlistEntry: command.suggestedAllowlistEntry ?? "",
      subcommandTokens: [...command.subcommandTokens],
    })),
  };
}

function classifierResultToInterop(value: CommandClassifierInternalResult | undefined): CommandClassifierResult | undefined {
  if (value === undefined) return undefined;
  if (value.kind !== "classification-succeeded" || !("commands" in value) || !("suggestedSandboxMode" in value)) {
    return new CommandClassifierResult({
      commands: [],
      suggestedSandboxMode: CommandClassifierResult_SuggestedSandboxMode.UNDETERMINED,
      classificationFailed: true,
    });
  }
  const mode = value.suggestedSandboxMode;
  const suggestedSandboxMode = mode === "SANDBOX"
    ? CommandClassifierResult_SuggestedSandboxMode.SANDBOX
    : mode === "NO_SANDBOX"
      ? CommandClassifierResult_SuggestedSandboxMode.NO_SANDBOX
      : /^unknown-\d+$/.test(mode)
        ? Number(mode.slice("unknown-".length)) as CommandClassifierResult_SuggestedSandboxMode
        : CommandClassifierResult_SuggestedSandboxMode.UNDETERMINED;
  return new CommandClassifierResult({
    commands: value.commands.map(command => new CommandClassifierResult_ClassifiedCommand({
      name: command.name,
      arguments: [...command.arguments],
      suggestedAllowlistEntry: command.suggestedAllowlistEntry,
      subcommandTokens: [...command.subcommandTokens],
    })),
    suggestedSandboxMode,
    classificationFailed: false,
  });
}

function parsingFromInterop(value: ShellCommandParsingResult | undefined): ShellCommandParsing | undefined {
  if (value === undefined) return undefined;
  return {
    failed: value.parsingFailed,
    executableCommands: value.executableCommands.map(command => ({
      name: command.name,
      fullText: command.fullText,
      arguments: command.args.map(argument => ({ type: argument.type, value: argument.value })),
    })),
    hasRedirects: value.hasRedirects,
    hasCommandSubstitution: value.hasCommandSubstitution,
    ...(value.allRedirectsAreDevNull === undefined ? {} : { allRedirectsAreDevNull: value.allRedirectsAreDevNull }),
    redirects: value.redirects.map(redirect => ({
      operator: redirect.operator,
      destinationFileDescriptors: [...redirect.destinationFds],
      targetNodeType: redirect.targetNodeType,
      ...(redirect.targetText === undefined ? {} : { targetText: redirect.targetText }),
    })),
  };
}

function parsingToInterop(value: ShellCommandParsing | undefined): ShellCommandParsingResult | undefined {
  if (value === undefined) return undefined;
  return new ShellCommandParsingResult({
    parsingFailed: value.failed,
    executableCommands: value.executableCommands.map(command => new ShellCommandParsingResult_ExecutableCommand({
      name: command.name,
      fullText: command.fullText,
      args: command.arguments.map(argument => new ShellCommandParsingResult_ExecutableCommandArg(argument)),
    })),
    hasRedirects: value.hasRedirects,
    hasCommandSubstitution: value.hasCommandSubstitution,
    ...(value.allRedirectsAreDevNull === undefined ? {} : { allRedirectsAreDevNull: value.allRedirectsAreDevNull }),
    redirects: value.redirects.map(redirect => new ShellCommandParsingResult_Redirect({
      operator: redirect.operator,
      destinationFds: [...redirect.destinationFileDescriptors],
      targetNodeType: redirect.targetNodeType,
      ...(redirect.targetText === undefined ? {} : { targetText: redirect.targetText }),
    })),
  });
}

function hookRequirementFromInterop(value: ShellHookApprovalRequirement | undefined): ShellExecutorArgs["hookApprovalRequirement"] {
  if (value === undefined) return undefined;
  if (value.kind === ShellHookApprovalRequirement_Kind.FORCE_PROMPT) {
    return { kind: "force-prompt", ...(value.reason === undefined ? {} : { reason: value.reason }) };
  }
  return { kind: "unknown", code: value.kind, ...(value.reason === undefined ? {} : { reason: value.reason }) };
}

function hookRequirementToInterop(value: ShellExecutorArgs["hookApprovalRequirement"]): ShellHookApprovalRequirement | undefined {
  if (value === undefined) return undefined;
  return new ShellHookApprovalRequirement({
    kind: value.kind === "force-prompt" ? ShellHookApprovalRequirement_Kind.FORCE_PROMPT : value.code as ShellHookApprovalRequirement_Kind,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  });
}

export function shellExecutorArgsFromInterop(value: ShellArgs): ShellExecutorArgs {
  const parsing = parsingFromInterop(value.parsingResult);
  const classifierResult = classifierResultFromInterop(value.classifierResult);
  const hookApprovalRequirement = hookRequirementFromInterop(value.hookApprovalRequirement);
  const timeoutBehavior = timeoutBehaviorFromInterop(value.timeoutBehavior);
  return {
    command: value.command,
    workingDirectory: value.workingDirectory,
    timeout: value.timeout,
    toolCallId: value.toolCallId,
    simpleCommands: [...value.simpleCommands],
    hasInputRedirect: value.hasInputRedirect,
    hasOutputRedirect: value.hasOutputRedirect,
    ...(parsing === undefined ? {} : { parsing }),
    ...(value.requestedSandboxPolicy === undefined ? {} : { requestedSandboxPolicy: adaptSandboxPolicyFromInterop(value.requestedSandboxPolicy) }),
    ...(value.fileOutputThresholdBytes === undefined ? {} : { fileOutputThresholdBytes: value.fileOutputThresholdBytes }),
    isBackground: value.isBackground,
    skipApproval: value.skipApproval,
    ...(timeoutBehavior === undefined ? {} : { timeoutBehavior }),
    ...(value.hardTimeout === undefined ? {} : { hardTimeout: value.hardTimeout }),
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(classifierResult === undefined ? {} : { classifierResult }),
    closeStdin: value.closeStdin,
    ...(value.outputNotification === undefined ? {} : { outputNotification: {
      pattern: value.outputNotification.pattern,
      reason: value.outputNotification.reason,
      ...(value.outputNotification.notificationLimit === undefined ? {} : { notificationLimit: value.outputNotification.notificationLimit }),
      ...(value.outputNotification.debounce === undefined ? {} : { debounceSeconds: value.outputNotification.debounce }),
    } }),
    ...(value.smartModeApproval === undefined ? {} : { smartModeApproval: { reason: value.smartModeApproval.reason, requestId: value.smartModeApproval.requestId } }),
    ...(hookApprovalRequirement === undefined ? {} : { hookApprovalRequirement }),
    ...(value.conversationId === undefined ? {} : { conversationId: value.conversationId }),
    adminCommandDenylist: [...value.adminCommandDenylist],
  };
}

function shellArgsToInterop(value: ShellExecutorArgs): ShellArgs {
  const parsingResult = parsingToInterop(value.parsing);
  const requestedSandboxPolicy = adaptSandboxPolicyToInterop(value.requestedSandboxPolicy);
  const classifierResult = classifierResultToInterop(value.classifierResult);
  const hookApprovalRequirement = hookRequirementToInterop(value.hookApprovalRequirement);
  return new ShellArgs({
    command: value.command,
    workingDirectory: value.workingDirectory ?? "",
    timeout: value.timeout ?? 0,
    toolCallId: value.toolCallId ?? "",
    simpleCommands: [...(value.simpleCommands ?? [])],
    hasInputRedirect: value.hasInputRedirect ?? false,
    hasOutputRedirect: value.hasOutputRedirect ?? false,
    ...(parsingResult === undefined ? {} : { parsingResult }),
    ...(requestedSandboxPolicy === undefined ? {} : { requestedSandboxPolicy }),
    ...(value.fileOutputThresholdBytes === undefined ? {} : { fileOutputThresholdBytes: value.fileOutputThresholdBytes }),
    isBackground: value.isBackground ?? false,
    skipApproval: value.skipApproval ?? false,
    timeoutBehavior: timeoutBehaviorToInterop(value.timeoutBehavior),
    ...(value.hardTimeout === undefined ? {} : { hardTimeout: value.hardTimeout }),
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(classifierResult === undefined ? {} : { classifierResult }),
    closeStdin: value.closeStdin ?? false,
    ...(value.outputNotification === undefined ? {} : { outputNotification: new ShellOutputNotificationConfig({
      pattern: value.outputNotification.pattern,
      reason: value.outputNotification.reason,
      ...(value.outputNotification.debounceSeconds === undefined ? {} : { debounce: value.outputNotification.debounceSeconds }),
      ...(value.outputNotification.notificationLimit === undefined ? {} : { notificationLimit: value.outputNotification.notificationLimit }),
    }) }),
    ...(value.smartModeApproval === undefined ? {} : { smartModeApproval: new SmartModeApproval({ ...value.smartModeApproval }) }),
    ...(hookApprovalRequirement === undefined ? {} : { hookApprovalRequirement }),
    ...(value.conversationId === undefined ? {} : { conversationId: value.conversationId }),
    adminCommandDenylist: [...(value.adminCommandDenylist ?? [])],
  });
}

function outputLocationFromInterop(value: OutputLocation | undefined): ShellOutputLocation | undefined {
  return value === undefined ? undefined : {
    filePath: value.filePath,
    sizeBytes: BigInt(value.sizeBytes),
    lineCount: BigInt(value.lineCount),
  };
}

function backgroundReasonFromInterop(value: number | undefined): ShellKnownOrUnknownReason<"user" | "timeout"> | undefined {
  if (value === undefined) return undefined;
  if (value === ShellBackgroundReason.USER_REQUEST) return "user";
  if (value === ShellBackgroundReason.TIMEOUT) return "timeout";
  return { kind: "unknown", code: value };
}

function abortReasonFromInterop(value: number | undefined): ShellKnownOrUnknownReason<"user-abort" | "timeout"> | undefined {
  if (value === undefined) return undefined;
  if (value === ShellAbortReason.USER_ABORT) return "user-abort";
  if (value === ShellAbortReason.TIMEOUT) return "timeout";
  return { kind: "unknown", code: value };
}

function shellOutcomeFromInterop(value: InteropShellResult["result"]): ShellExecResult {
  switch (value.case) {
    case "success": {
      const result = value.value;
      const outputFile = outputLocationFromInterop(result.outputLocation);
      const backgroundReason = backgroundReasonFromInterop(result.backgroundReason);
      return {
        kind: "success",
        command: result.command,
        workingDirectory: result.workingDirectory,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        executionTimeMs: result.executionTime,
        ...(outputFile === undefined ? {} : { outputFile }),
        ...(result.shellId === undefined ? {} : { shellId: result.shellId }),
        ...(result.interleavedOutput === undefined ? {} : { interleavedOutput: result.interleavedOutput }),
        ...(result.pid === undefined ? {} : { processId: result.pid }),
        ...(result.msToWait === undefined ? {} : { waitedMs: result.msToWait }),
        ...(result.localExecutionTimeMs === undefined ? {} : { localExecutionTimeMs: result.localExecutionTimeMs }),
        ...(backgroundReason === undefined ? {} : { backgroundReason }),
        ...(result.outputHead === undefined ? {} : { outputHead: result.outputHead }),
        ...(result.outputTail === undefined ? {} : { outputTail: result.outputTail }),
        ...(result.elidedChars === undefined ? {} : { elidedCharacters: result.elidedChars }),
      };
    }
    case "failure": {
      const result = value.value;
      const outputFile = outputLocationFromInterop(result.outputLocation);
      const abortReason = abortReasonFromInterop(result.abortReason);
      return {
        kind: "failure",
        command: result.command,
        workingDirectory: result.workingDirectory,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        executionTimeMs: result.executionTime,
        ...(outputFile === undefined ? {} : { outputFile }),
        ...(result.interleavedOutput === undefined ? {} : { interleavedOutput: result.interleavedOutput }),
        aborted: result.aborted,
        ...(abortReason === undefined ? {} : { abortReason }),
        ...(result.localExecutionTimeMs === undefined ? {} : { localExecutionTimeMs: result.localExecutionTimeMs }),
        ...(result.outputHead === undefined ? {} : { outputHead: result.outputHead }),
        ...(result.outputTail === undefined ? {} : { outputTail: result.outputTail }),
        ...(result.elidedChars === undefined ? {} : { elidedCharacters: result.elidedChars }),
      };
    }
    case "timeout":
      return { kind: "timeout", command: value.value.command, workingDirectory: value.value.workingDirectory, timeoutMs: value.value.timeoutMs };
    case "rejected":
      return { kind: "rejected", command: value.value.command, workingDirectory: value.value.workingDirectory, reason: value.value.reason, isReadonly: value.value.isReadonly };
    case "spawnError":
      return { kind: "spawn-error", command: value.value.command, workingDirectory: value.value.workingDirectory, message: value.value.error };
    case "permissionDenied":
      return { kind: "permission-denied", command: value.value.command, workingDirectory: value.value.workingDirectory, message: value.value.error, isReadonly: value.value.isReadonly };
    case undefined:
      return { kind: "unrecognized" };
  }
}

function outputLocationToInterop(value: ShellOutputLocation | undefined): OutputLocation | undefined {
  return value === undefined ? undefined : new OutputLocation({ filePath: value.filePath, sizeBytes: value.sizeBytes, lineCount: value.lineCount });
}

function backgroundReasonToInterop(value: ShellKnownOrUnknownReason<"user" | "timeout"> | undefined): ShellBackgroundReason | undefined {
  if (value === undefined) return undefined;
  if (value === "user") return ShellBackgroundReason.USER_REQUEST;
  if (value === "timeout") return ShellBackgroundReason.TIMEOUT;
  return value.code as ShellBackgroundReason;
}

function abortReasonToInterop(value: ShellKnownOrUnknownReason<"user-abort" | "timeout"> | undefined): ShellAbortReason | undefined {
  if (value === undefined) return undefined;
  if (value === "user-abort") return ShellAbortReason.USER_ABORT;
  if (value === "timeout") return ShellAbortReason.TIMEOUT;
  return value.code as ShellAbortReason;
}

function shellOutcomeToInterop(value: ShellExecResult): InteropShellResult["result"] {
  switch (value.kind) {
    case "success": {
      const outputLocation = outputLocationToInterop(value.outputFile);
      const backgroundReason = backgroundReasonToInterop(value.backgroundReason);
      return {
        case: "success",
        value: new ShellSuccess({
          command: value.command,
          workingDirectory: value.workingDirectory,
          exitCode: value.exitCode,
          signal: value.signal,
          stdout: value.stdout,
          stderr: value.stderr,
          executionTime: value.executionTimeMs,
          ...(outputLocation === undefined ? {} : { outputLocation }),
          ...(value.shellId === undefined ? {} : { shellId: value.shellId }),
          ...(value.interleavedOutput === undefined ? {} : { interleavedOutput: value.interleavedOutput }),
          ...(value.processId === undefined ? {} : { pid: value.processId }),
          ...(value.waitedMs === undefined ? {} : { msToWait: value.waitedMs }),
          ...(value.localExecutionTimeMs === undefined ? {} : { localExecutionTimeMs: value.localExecutionTimeMs }),
          ...(backgroundReason === undefined ? {} : { backgroundReason }),
          ...(value.outputHead === undefined ? {} : { outputHead: value.outputHead }),
          ...(value.outputTail === undefined ? {} : { outputTail: value.outputTail }),
          ...(value.elidedCharacters === undefined ? {} : { elidedChars: value.elidedCharacters }),
        }),
      };
    }
    case "failure": {
      const outputLocation = outputLocationToInterop(value.outputFile);
      const abortReason = abortReasonToInterop(value.abortReason);
      return {
        case: "failure",
        value: new ShellFailure({
          command: value.command,
          workingDirectory: value.workingDirectory,
          exitCode: value.exitCode,
          signal: value.signal,
          stdout: value.stdout,
          stderr: value.stderr,
          executionTime: value.executionTimeMs,
          ...(outputLocation === undefined ? {} : { outputLocation }),
          ...(value.interleavedOutput === undefined ? {} : { interleavedOutput: value.interleavedOutput }),
          ...(abortReason === undefined ? {} : { abortReason }),
          aborted: value.aborted,
          ...(value.localExecutionTimeMs === undefined ? {} : { localExecutionTimeMs: value.localExecutionTimeMs }),
          ...(value.outputHead === undefined ? {} : { outputHead: value.outputHead }),
          ...(value.outputTail === undefined ? {} : { outputTail: value.outputTail }),
          ...(value.elidedCharacters === undefined ? {} : { elidedChars: value.elidedCharacters }),
        }),
      };
    }
    case "timeout":
      return { case: "timeout", value: new ShellTimeout({ command: value.command, workingDirectory: value.workingDirectory, timeoutMs: value.timeoutMs }) };
    case "rejected":
      return { case: "rejected", value: new ShellRejected({ command: value.command, workingDirectory: value.workingDirectory, reason: value.reason, isReadonly: value.isReadonly }) };
    case "spawn-error":
      return { case: "spawnError", value: new ShellSpawnError({ command: value.command, workingDirectory: value.workingDirectory, error: value.message }) };
    case "permission-denied":
      return { case: "permissionDenied", value: new ShellPermissionDenied({ command: value.command, workingDirectory: value.workingDirectory, error: value.message, isReadonly: value.isReadonly }) };
    case "unrecognized":
      return { case: undefined };
  }
}

function shellResultFromInterop(value: InteropShellResult): ShellExecResponse {
  return {
    outcome: shellOutcomeFromInterop(value.result),
    ...(value.sandboxPolicy === undefined ? {} : { sandboxPolicy: adaptSandboxPolicyFromInterop(value.sandboxPolicy) }),
    ...(value.isBackground === undefined ? {} : { isBackground: value.isBackground }),
    ...(value.terminalsFolder === undefined ? {} : { terminalsFolder: value.terminalsFolder }),
    ...(value.pid === undefined ? {} : { processId: value.pid }),
  };
}

function shellResultToInterop(value: ShellExecResponse): ShellResult {
  const sandboxPolicy = adaptSandboxPolicyToInterop(value.sandboxPolicy);
  return new ShellResult({
    result: shellOutcomeToInterop(value.outcome),
    ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
    ...(value.isBackground === undefined ? {} : { isBackground: value.isBackground }),
    ...(value.terminalsFolder === undefined ? {} : { terminalsFolder: value.terminalsFolder }),
    ...(value.processId === undefined ? {} : { pid: value.processId }),
  });
}

export const shellExecutorResource = createResource<ShellExecutor, RemoteExecManager, ControlledExecManager>(
  (manager) => {
    const serializeArgs = createServerSerializer("shellArgs");
    const deserializeResult = createClientDeserializer("shellResult");
    return new ExecutorResource(
      manager,
      (id, args, options) => serializeArgs(id, shellArgsToInterop(args), options),
      (message) => {
        const decoded = deserializeResult(message);
        return {
          value: decoded.value === undefined ? undefined : shellResultFromInterop(decoded.value),
          ...(decoded.hookContexts === undefined ? {} : { hookContexts: decoded.hookContexts }),
        };
      },
    );
  },
  (implementation, manager) => {
    const interopImplementation: Executor<InteropShellArgs, InteropShellResult> = {
      async execute(context, args, options) {
        return shellResultToInterop(await implementation.execute(context, shellExecutorArgsFromInterop(args), options));
      },
    };
    manager.register(new SimpleControlledExecHandler<InteropShellArgs, InteropShellResult>(
      interopImplementation,
      createServerDeserializer("shellArgs"),
      createClientSerializer("shellResult"),
    ));
  },
);
