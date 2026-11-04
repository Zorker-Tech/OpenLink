/** Bind the foreground shell operation to the generated executor message cases. */

import type { ShellArgs, ShellResult } from "../proto/generated/agent/v1/shell_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export type ShellExecutorArgs = ShellArgs;
export type ShellExecResult = ShellResult["result"];
export type ShellExecResponse = ShellResult;
export type ShellExecutor = Executor<ShellExecutorArgs, ShellExecResponse>;

export const shellExecutorResource = createResource<ShellExecutor, RemoteExecManager, ControlledExecManager>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("shellArgs"),
    createClientDeserializer("shellResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("shellArgs"),
    createClientSerializer("shellResult"),
  )),
);
