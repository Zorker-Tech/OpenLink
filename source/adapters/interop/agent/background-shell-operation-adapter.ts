/** Maps Slate durable-shell contracts to their generated transport frames. */

import {
  BackgroundShellSpawnArgs,
  BackgroundShellSpawnError,
  BackgroundShellSpawnResult,
  BackgroundShellSpawnSuccess,
  WriteShellStdinArgs,
  WriteShellStdinError,
  WriteShellStdinResult,
  WriteShellStdinSuccess,
  type BackgroundShellSpawnResult as InteropBackgroundShellSpawnResult,
  type WriteShellStdinResult as InteropWriteShellStdinResult,
} from "../proto/generated/agent/v1/background_shell_exec_pb.ts";
import { ShellPermissionDenied, ShellRejected, ShellSandboxUnsupported } from "../proto/generated/agent/v1/shell_exec_pb.ts";
import type {
  BackgroundShellSpawnInput,
  BackgroundShellSpawnOutcome,
} from "../../../packages/local-exec/background-shell-contracts.ts";
import {
  type BackgroundShellExecutor,
  type BackgroundShellExecutorArgs,
  type BackgroundShellExecutorResult,
  type WriteBackgroundShellInputArgs,
  type WriteBackgroundShellInputExecutor,
  type WriteBackgroundShellInputResult,
} from "../../../packages/agent-exec/background-shell.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";
import { adaptSandboxPolicyFromInterop, adaptSandboxPolicyToInterop } from "./sandbox-policy-adapter.ts";

export function backgroundShellSpawnInputFromInterop(value: unknown): BackgroundShellExecutorArgs {
  if (typeof value !== "object" || value === null) throw new TypeError("background shell request is missing");
  const args = value as BackgroundShellSpawnArgs;
  return {
    command: args.command,
    workingDirectory: args.workingDirectory,
    toolCallId: args.toolCallId,
    enableWriteShellStdinTool: args.enableWriteShellStdinTool,
    skipApproval: args.skipApproval,
    ...(args.adminCommandDenylist.length === 0 ? {} : { adminCommandDenylist: [...args.adminCommandDenylist] }),
    ...(args.sandboxPolicy === undefined ? {} : { sandboxPolicy: adaptSandboxPolicyFromInterop(args.sandboxPolicy) }),
    ...(args.smartModeApproval === undefined ? {} : { smartModeApproval: { reason: args.smartModeApproval.reason, requestId: args.smartModeApproval.requestId } }),
    ...(args.description === undefined ? {} : { description: args.description }),
    ...(args.classifierResult === undefined ? {} : { classifierResult: args.classifierResult }),
    ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
    ...(args.outputNotification === undefined ? {} : { outputNotification: args.outputNotification }),
    ...(args.hookApprovalRequirement === undefined ? {} : { hookApprovalRequirement: args.hookApprovalRequirement }),
  };
}

export function backgroundShellSpawnInputToInterop(value: BackgroundShellExecutorArgs): BackgroundShellSpawnArgs {
  const sandboxPolicy = value.sandboxPolicy === undefined ? undefined : adaptSandboxPolicyToInterop(value.sandboxPolicy);
  return new BackgroundShellSpawnArgs({
    command: value.command,
    workingDirectory: value.workingDirectory ?? "",
    toolCallId: value.toolCallId ?? "",
    ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
    enableWriteShellStdinTool: value.enableWriteShellStdinTool ?? false,
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.classifierResult === undefined ? {} : { classifierResult: value.classifierResult as never }),
    ...(value.outputNotification === undefined ? {} : { outputNotification: value.outputNotification as never }),
    ...(value.smartModeApproval === undefined ? {} : { smartModeApproval: value.smartModeApproval }),
    ...(value.hookApprovalRequirement === undefined ? {} : { hookApprovalRequirement: value.hookApprovalRequirement as never }),
    skipApproval: value.skipApproval ?? false,
    ...(value.conversationId === undefined ? {} : { conversationId: value.conversationId }),
    adminCommandDenylist: [...(value.adminCommandDenylist ?? [])],
  });
}

export function backgroundShellSpawnOutcomeFromLocal(value: BackgroundShellSpawnOutcome): BackgroundShellExecutorResult {
  switch (value.kind) {
    case "success":
      return { ...value };
    case "rejected":
      return { ...value };
    case "permission_denied":
      return {
        kind: "permission-denied",
        command: value.command,
        workingDirectory: value.workingDirectory,
        message: value.error,
        isReadonly: value.isReadonly,
      };
    case "sandbox_unsupported":
      return {
        kind: "sandbox-unsupported",
        command: value.command,
        workingDirectory: value.workingDirectory,
        policyType: value.sandboxPolicyType,
        reason: value.reason,
        isReadonly: value.isReadonly,
      };
    case "error":
      return { ...value };
  }
}

export function backgroundShellSpawnResultFromInterop(value: InteropBackgroundShellSpawnResult): BackgroundShellExecutorResult {
  switch (value.result.case) {
    case "success":
      return {
        kind: "success",
        shellId: value.result.value.shellId,
        command: value.result.value.command,
        workingDirectory: value.result.value.workingDirectory,
        ...(value.result.value.pid === undefined ? {} : { pid: value.result.value.pid }),
      };
    case "error":
      return { kind: "error", command: value.result.value.command, workingDirectory: value.result.value.workingDirectory, error: value.result.value.error };
    case "rejected":
      return { kind: "rejected", command: value.result.value.command, workingDirectory: value.result.value.workingDirectory, reason: value.result.value.reason };
    case "permissionDenied":
      return { kind: "permission-denied", command: value.result.value.command, workingDirectory: value.result.value.workingDirectory, message: value.result.value.error, isReadonly: value.result.value.isReadonly };
    case "sandboxUnsupported":
      return { kind: "sandbox-unsupported", command: value.result.value.command, workingDirectory: value.result.value.workingDirectory, policyType: value.result.value.sandboxPolicyType, reason: value.result.value.reason, isReadonly: value.result.value.isReadonly };
    case undefined:
      return { kind: "unrecognized" };
  }
}

export function backgroundShellSpawnResultToInterop(value: BackgroundShellExecutorResult): InteropBackgroundShellSpawnResult {
  switch (value.kind) {
    case "success":
      return new BackgroundShellSpawnResult({ result: { case: "success", value: new BackgroundShellSpawnSuccess({
        shellId: value.shellId,
        command: value.command,
        workingDirectory: value.workingDirectory,
        ...(value.pid === undefined ? {} : { pid: value.pid }),
      }) } });
    case "rejected":
      return new BackgroundShellSpawnResult({ result: { case: "rejected", value: new ShellRejected({ command: value.command, workingDirectory: value.workingDirectory, reason: value.reason }) } });
    case "permission-denied":
      return new BackgroundShellSpawnResult({ result: { case: "permissionDenied", value: new ShellPermissionDenied({ command: value.command, workingDirectory: value.workingDirectory, error: value.message, isReadonly: value.isReadonly }) } });
    case "sandbox-unsupported":
      return new BackgroundShellSpawnResult({ result: { case: "sandboxUnsupported", value: new ShellSandboxUnsupported({ command: value.command, workingDirectory: value.workingDirectory, sandboxPolicyType: value.policyType, reason: value.reason, isReadonly: value.isReadonly }) } });
    case "error":
      return new BackgroundShellSpawnResult({ result: { case: "error", value: new BackgroundShellSpawnError({ command: value.command, workingDirectory: value.workingDirectory, error: value.error }) } });
    case "unrecognized":
      return new BackgroundShellSpawnResult();
  }
}

export function writeBackgroundShellInputArgsFromInterop(value: WriteShellStdinArgs): WriteBackgroundShellInputArgs {
  return { shellId: value.shellId, text: value.chars };
}

export function writeBackgroundShellInputArgsToInterop(value: WriteBackgroundShellInputArgs): WriteShellStdinArgs {
  return new WriteShellStdinArgs({ shellId: value.shellId, chars: value.text });
}

export function writeBackgroundShellInputResultFromInterop(value: InteropWriteShellStdinResult): WriteBackgroundShellInputResult {
  switch (value.result.case) {
    case "success":
      return { kind: "success", shellId: value.result.value.shellId, terminalLengthBeforeWrite: value.result.value.terminalFileLengthBeforeInputWritten };
    case "error":
      return { kind: "error", message: value.result.value.error };
    case undefined:
      return { kind: "unrecognized" };
  }
}

export function writeBackgroundShellInputResultToInterop(value: WriteBackgroundShellInputResult): InteropWriteShellStdinResult {
  switch (value.kind) {
    case "success":
      return new WriteShellStdinResult({ result: { case: "success", value: new WriteShellStdinSuccess({ shellId: value.shellId, terminalFileLengthBeforeInputWritten: value.terminalLengthBeforeWrite }) } });
    case "error":
      return new WriteShellStdinResult({ result: { case: "error", value: new WriteShellStdinError({ error: value.message }) } });
    case "unrecognized":
      return new WriteShellStdinResult();
  }
}

export const backgroundShellExecutorResource = createResource<BackgroundShellExecutor, RemoteExecManager, ControlledExecManager>(
  (manager) => {
    const serializeArgs = createServerSerializer("backgroundShellSpawnArgs");
    const deserializeResult = createClientDeserializer("backgroundShellSpawnResult");
    return new ExecutorResource(
      manager,
      (id, args, options) => serializeArgs(id, backgroundShellSpawnInputToInterop(args), options),
      (message) => {
        const decoded = deserializeResult(message);
        return {
          value: decoded.value === undefined ? undefined : backgroundShellSpawnResultFromInterop(decoded.value),
          ...(decoded.hookContexts === undefined ? {} : { hookContexts: decoded.hookContexts }),
        };
      },
    );
  },
  (implementation, manager) => {
    const interopImplementation: Executor<BackgroundShellSpawnArgs, BackgroundShellSpawnResult> = {
      async execute(ctx, args, options) {
        return backgroundShellSpawnResultToInterop(await implementation.execute(ctx, backgroundShellSpawnInputFromInterop(args), options));
      },
    };
    manager.register(new SimpleControlledExecHandler(
      interopImplementation,
      createServerDeserializer("backgroundShellSpawnArgs"),
      createClientSerializer("backgroundShellSpawnResult"),
    ));
  },
);

export const writeBackgroundShellInputExecutorResource = createResource<
  WriteBackgroundShellInputExecutor,
  RemoteExecManager,
  ControlledExecManager
>(
  (manager) => {
    const serializeArgs = createServerSerializer("writeShellStdinArgs");
    const deserializeResult = createClientDeserializer("writeShellStdinResult");
    return new ExecutorResource(
      manager,
      (id, args, options) => serializeArgs(id, writeBackgroundShellInputArgsToInterop(args), options),
      (message) => {
        const decoded = deserializeResult(message);
        return {
          value: decoded.value === undefined ? undefined : writeBackgroundShellInputResultFromInterop(decoded.value),
          ...(decoded.hookContexts === undefined ? {} : { hookContexts: decoded.hookContexts }),
        };
      },
    );
  },
  (implementation, manager) => {
    const interopImplementation: Executor<WriteShellStdinArgs, WriteShellStdinResult> = {
      async execute(ctx, args, options) {
        return writeBackgroundShellInputResultToInterop(await implementation.execute(ctx, writeBackgroundShellInputArgsFromInterop(args), options));
      },
    };
    manager.register(new SimpleControlledExecHandler(
      interopImplementation,
      createServerDeserializer("writeShellStdinArgs"),
      createClientSerializer("writeShellStdinResult"),
    ));
  },
);
