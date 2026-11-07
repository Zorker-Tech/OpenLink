/** Converts Slate shell handoff requests at the executor transport edge. */

import {
  ForceBackgroundShellArgs,
  ForceBackgroundShellResult,
  ForceBackgroundShellStatus,
} from "../proto/generated/agent/v1/shell_exec_pb.ts";
import type { ShellControlArgs, ShellControlExecutor, ShellControlResult } from "../../../packages/agent-exec/shell-control.ts";
import type { Executor, RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { ExecutorResource } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";
import { shellResultFromInterop, shellResultToInterop } from "./shell-operation-adapter.ts";

function shellControlArgsToInterop(value: ShellControlArgs): ForceBackgroundShellArgs {
  return new ForceBackgroundShellArgs({ toolCallId: value.toolCallId });
}

function shellControlArgsFromInterop(value: ForceBackgroundShellArgs): ShellControlArgs {
  return { toolCallId: value.toolCallId };
}

function shellControlResultFromInterop(value: ForceBackgroundShellResult): ShellControlResult {
  const shellResult = value.shellResult === undefined ? undefined : shellResultFromInterop(value.shellResult);
  if (value.status === ForceBackgroundShellStatus.ACCEPTED) {
    return { kind: "accepted", ...(shellResult === undefined ? {} : { shellResult }) };
  }
  if (value.status === ForceBackgroundShellStatus.NOT_FOUND) {
    return { kind: "not-found", ...(shellResult === undefined ? {} : { shellResult }) };
  }
  return {
    kind: "unrecognized",
    code: value.status,
    ...(shellResult === undefined ? {} : { shellResult }),
  };
}

function shellControlResultToInterop(value: ShellControlResult): ForceBackgroundShellResult {
  switch (value.kind) {
    case "accepted":
      return new ForceBackgroundShellResult({
        status: ForceBackgroundShellStatus.ACCEPTED,
        ...(value.shellResult === undefined ? {} : { shellResult: shellResultToInterop(value.shellResult) }),
      });
    case "not-found":
      return new ForceBackgroundShellResult({
        status: ForceBackgroundShellStatus.NOT_FOUND,
        ...(value.shellResult === undefined ? {} : { shellResult: shellResultToInterop(value.shellResult) }),
      });
    case "unrecognized":
      return new ForceBackgroundShellResult({
        status: value.code as ForceBackgroundShellStatus,
        ...(value.shellResult === undefined ? {} : { shellResult: shellResultToInterop(value.shellResult) }),
      });
  }
}

export const forceBackgroundShellExecutorResource = createResource<ShellControlExecutor, RemoteExecManager, ControlledExecManager>(
  (manager) => {
    const serializeArgs = createServerSerializer("forceBackgroundShellArgs");
    const deserializeResult = createClientDeserializer("forceBackgroundShellResult");
    return new ExecutorResource(
      manager,
      (id, args, options) => serializeArgs(id, shellControlArgsToInterop(args), options),
      (message) => {
        const decoded = deserializeResult(message);
        return {
          value: decoded.value === undefined ? undefined : shellControlResultFromInterop(decoded.value),
          ...(decoded.hookContexts === undefined ? {} : { hookContexts: decoded.hookContexts }),
        };
      },
    );
  },
  (implementation, manager) => {
    const interopImplementation: Executor<ForceBackgroundShellArgs, ForceBackgroundShellResult> = {
      async execute(context, args, options) {
        return shellControlResultToInterop(await implementation.execute(context, shellControlArgsFromInterop(args), options));
      },
    };
    manager.register(new SimpleControlledExecHandler(
      interopImplementation,
      createServerDeserializer("forceBackgroundShellArgs"),
      createClientSerializer("forceBackgroundShellResult"),
    ));
  },
);
