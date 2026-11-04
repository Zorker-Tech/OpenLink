/** Bind background-shell operations to their generated executor request and result cases. */

import {
  BackgroundShellSpawnError,
  BackgroundShellSpawnResult,
  BackgroundShellSpawnSuccess,
  type BackgroundShellSpawnArgs,
  type BackgroundShellSpawnResult as BackgroundShellSpawnResultMessage,
  type WriteShellStdinArgs,
  type WriteShellStdinResult,
} from "../proto/generated/agent/v1/background_shell_exec_pb.ts";
import {
  ShellPermissionDenied,
  ShellRejected,
  ShellSandboxUnsupported,
} from "../proto/generated/agent/v1/shell_exec_pb.ts";
import type {
  BackgroundShellSpawnInput,
  BackgroundShellSpawnOutcome,
} from "../../../packages/local-exec/background-shell-contracts.ts";
import { adaptSandboxPolicyFromInterop } from "./sandbox-policy-adapter.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import {
  ExecutorResource,
  type Executor,
  type ExecutorDecodedValue,
  type ExecutorWireRequestOptions,
  type RemoteExecManager,
} from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
  type InteropExecClientMessage,
  type InteropExecServerMessage,
} from "./exec-message-adapter.ts";

function executorResource<Args, Result>(requestCase: string, resultCase: string) {
  return createResource<Executor<Args, Result>, RemoteExecManager, ControlledExecManager>(
    (manager) => {
      const serializeArgs = createServerSerializer(requestCase as never) as unknown as (
        id: number,
        args: Args,
        options: ExecutorWireRequestOptions,
      ) => InteropExecServerMessage;
      const deserializeResult = createClientDeserializer(resultCase as never) as unknown as (
        message: InteropExecClientMessage,
      ) => ExecutorDecodedValue<Result>;
      return new ExecutorResource<Args, Result>(manager, serializeArgs, deserializeResult);
    },
    (implementation, manager) => {
      const deserializeArgs = createServerDeserializer(requestCase as never) as unknown as (
        message: InteropExecServerMessage,
      ) => { id: number; args: Args } | undefined;
      const serializeResult = createClientSerializer(resultCase as never) as unknown as (
        id: number,
        result: Result,
      ) => InteropExecClientMessage;
      manager.register(new SimpleControlledExecHandler<Args, Result>(
        implementation,
        deserializeArgs,
        serializeResult,
      ));
    },
  );
}

export const backgroundShellExecutorResource = executorResource<BackgroundShellSpawnArgs, BackgroundShellSpawnResult>(
  "backgroundShellSpawnArgs",
  "backgroundShellSpawnResult",
);

export const writeBackgroundShellInputExecutorResource = executorResource<WriteShellStdinArgs, WriteShellStdinResult>(
  "writeShellStdinArgs",
  "writeShellStdinResult",
);

/** Projects one generated spawn request into the local executor's Slate-owned input. */
export function backgroundShellSpawnInputFromInterop(value: unknown): BackgroundShellSpawnInput {
  if (typeof value !== "object" || value === null) throw new TypeError("background shell request is missing");
  const args = value as BackgroundShellSpawnArgs;
  return {
    command: args.command,
    workingDirectory: args.workingDirectory,
    toolCallId: args.toolCallId,
    enableWriteShellStdinTool: args.enableWriteShellStdinTool,
    skipApproval: args.skipApproval,
    adminCommandDenylist: [...args.adminCommandDenylist],
    ...(args.sandboxPolicy === undefined ? {} : { sandboxPolicy: adaptSandboxPolicyFromInterop(args.sandboxPolicy) }),
    ...(args.smartModeApproval === undefined ? {} : { smartModeApproval: { reason: args.smartModeApproval.reason, requestId: args.smartModeApproval.requestId } }),
    ...(args.description === undefined ? {} : { description: args.description }),
    ...(args.classifierResult === undefined ? {} : { classifierResult: args.classifierResult }),
    ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
    ...(args.outputNotification === undefined ? {} : { outputNotification: args.outputNotification }),
    ...(args.hookApprovalRequirement === undefined ? {} : { hookApprovalRequirement: args.hookApprovalRequirement }),
  };
}

/** Encodes the local executor's Slate-owned spawn outcome for the remote executor resource. */
export function backgroundShellSpawnOutcomeToInterop(outcome: BackgroundShellSpawnOutcome): BackgroundShellSpawnResultMessage {
  switch (outcome.kind) {
    case "success":
      return new BackgroundShellSpawnResult({ result: { case: "success", value: new BackgroundShellSpawnSuccess({ shellId: outcome.shellId, command: outcome.command, workingDirectory: outcome.workingDirectory, ...(outcome.pid === undefined ? {} : { pid: outcome.pid }) }) } });
    case "rejected":
      return new BackgroundShellSpawnResult({ result: { case: "rejected", value: new ShellRejected({ command: outcome.command, workingDirectory: outcome.workingDirectory, reason: outcome.reason }) } });
    case "permission_denied":
      return new BackgroundShellSpawnResult({ result: { case: "permissionDenied", value: new ShellPermissionDenied({ command: outcome.command, workingDirectory: outcome.workingDirectory, error: outcome.error, isReadonly: outcome.isReadonly }) } });
    case "sandbox_unsupported":
      return new BackgroundShellSpawnResult({ result: { case: "sandboxUnsupported", value: new ShellSandboxUnsupported({ command: outcome.command, workingDirectory: outcome.workingDirectory, sandboxPolicyType: outcome.sandboxPolicyType, reason: outcome.reason, isReadonly: outcome.isReadonly }) } });
    case "error":
      return new BackgroundShellSpawnResult({ result: { case: "error", value: new BackgroundShellSpawnError({ command: outcome.command, workingDirectory: outcome.workingDirectory, error: outcome.error }) } });
  }
}
