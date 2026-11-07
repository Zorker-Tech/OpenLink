/** Maps Slate shell-stream operations to and from the executor transport frame. */

import {
  ShellArgs,
  type ShellStream,
} from "../proto/generated/agent/v1/shell_exec_pb.ts";
import type { ShellStreamExecutorArgs, ShellStreamExecutor, ShellStreamExecutorEvent } from "../../../packages/agent-exec/shell-stream-operation.ts";
import type { ShellStreamArgs as LocalShellStreamArgs } from "../../../packages/local-exec/shell-stream-contracts.ts";
import type { LocalShellStreamEvent } from "../../../packages/local-exec/shell-stream-events.ts";
import { StreamExecutorResource, type RemoteExecManager, type StreamExecutor } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import { SimpleControlledStreamExecHandler } from "./controlled-exec-manager-adapter.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";
import { localShellStreamEventFromInterop, localShellStreamEventToInterop, shellTimeoutBehaviorFromInterop, shellTimeoutBehaviorToInterop } from "./local-shell-stream-executor-adapter.ts";
import { adaptSandboxPolicyFromInterop, adaptSandboxPolicyToInterop } from "./sandbox-policy-adapter.ts";

function shellStreamArgsFromInterop(value: ShellArgs): ShellStreamExecutorArgs {
  const args: LocalShellStreamArgs = {
    command: value.command,
    workingDirectory: value.workingDirectory,
    toolCallId: value.toolCallId,
    ...(value.conversationId === undefined ? {} : { conversationId: value.conversationId }),
    ...(value.requestedSandboxPolicy === undefined ? {} : { requestedSandboxPolicy: adaptSandboxPolicyFromInterop(value.requestedSandboxPolicy) }),
    closeStdin: value.closeStdin,
    timeout: value.timeout,
    timeoutBehavior: shellTimeoutBehaviorFromInterop(value.timeoutBehavior),
    ...(value.hardTimeout === undefined ? {} : { hardTimeout: value.hardTimeout }),
    ...(value.fileOutputThresholdBytes === undefined ? {} : { fileOutputThresholdBytes: Number(value.fileOutputThresholdBytes) }),
    adminCommandDenylist: [...value.adminCommandDenylist],
    skipApproval: value.skipApproval,
    ...(value.smartModeApproval === undefined ? {} : { smartModeApproval: { reason: value.smartModeApproval.reason, requestId: value.smartModeApproval.requestId } }),
    ...(value.classifierResult === undefined ? {} : { classifierResult: value.classifierResult }),
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.outputNotification === undefined ? {} : { outputNotification: value.outputNotification }),
    ...(value.hookApprovalRequirement === undefined ? {} : { hookApprovalRequirement: value.hookApprovalRequirement }),
    isBackground: value.isBackground,
  };
  return args;
}

function thresholdAsInteropInteger(value: number | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  return BigInt(value);
}

function shellStreamArgsToInterop(value: ShellStreamExecutorArgs): ShellArgs {
  const requestedSandboxPolicy = adaptSandboxPolicyToInterop(value.requestedSandboxPolicy);
  const fileOutputThresholdBytes = thresholdAsInteropInteger(value.fileOutputThresholdBytes);
  return new ShellArgs({
    command: value.command,
    workingDirectory: value.workingDirectory ?? "",
    timeout: value.timeout ?? 0,
    toolCallId: value.toolCallId ?? "",
    ...(requestedSandboxPolicy === undefined ? {} : { requestedSandboxPolicy }),
    ...(fileOutputThresholdBytes === undefined ? {} : { fileOutputThresholdBytes }),
    isBackground: value.isBackground ?? false,
    skipApproval: value.skipApproval ?? false,
    timeoutBehavior: shellTimeoutBehaviorToInterop(value.timeoutBehavior),
    ...(value.hardTimeout === undefined ? {} : { hardTimeout: value.hardTimeout }),
    ...(value.description === undefined ? {} : { description: value.description }),
    closeStdin: value.closeStdin ?? false,
    ...(value.classifierResult === undefined ? {} : { classifierResult: value.classifierResult as never }),
    ...(value.outputNotification === undefined ? {} : { outputNotification: value.outputNotification as never }),
    ...(value.smartModeApproval === undefined ? {} : { smartModeApproval: value.smartModeApproval }),
    ...(value.hookApprovalRequirement === undefined ? {} : { hookApprovalRequirement: value.hookApprovalRequirement as never }),
    ...(value.conversationId === undefined ? {} : { conversationId: value.conversationId }),
    adminCommandDenylist: [...(value.adminCommandDenylist ?? [])],
  });
}

function interopExecutor(implementation: ShellStreamExecutor): StreamExecutor<ShellArgs, ShellStream> {
  return {
    async *execute(context, args, options) {
      for await (const event of implementation.execute(context, shellStreamArgsFromInterop(args), options)) {
        yield localShellStreamEventToInterop(event as LocalShellStreamEvent);
      }
    },
  };
}

function decodeEvent(stream: ShellStream): ShellStreamExecutorEvent {
  return localShellStreamEventFromInterop(stream);
}

export const shellStreamExecutorResource = createResource<ShellStreamExecutor, RemoteExecManager, ControlledExecManager>(
  (manager) => {
    const serializeArgs = createServerSerializer("shellStreamArgs");
    const deserializeEvent = createClientDeserializer("shellStream");
    return new StreamExecutorResource(
      manager,
      (id, args, options) => serializeArgs(id, shellStreamArgsToInterop(args), options),
      (message) => {
        const decoded = deserializeEvent(message);
        return {
          value: decoded.value === undefined ? undefined : decodeEvent(decoded.value),
          ...(decoded.hookContexts === undefined ? {} : { hookContexts: decoded.hookContexts }),
        };
      },
    );
  },
  (implementation, manager) => manager.register(new SimpleControlledStreamExecHandler(
    interopExecutor(implementation),
    createServerDeserializer("shellStreamArgs"),
    createClientSerializer("shellStream"),
  )),
);
