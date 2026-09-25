/**
 * The operation that runs a shell command, and the shapes its arguments and results take.
 *
 * A shell call is the operation with the most going on around it — the command, the sandbox it runs in, whether it is backgrounded, how its output is chunked — so the arguments and the result are named here rather than inline, and the executor type is what the client side is built from. Nothing about running a command is decided in this module: it is the contract the two ends agree on.
 */

import { SimpleControlledExecHandler } from "./controlled-exec.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./executor-resources.ts";
import { createResource, type ControlledExecManager } from "./resource-provider.ts";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./exec-serialization.ts";
import type { ShellArgs, ShellResult } from "../proto/generated/agent/v1/shell_exec_pb.ts";

export type ShellExecutorArgs = ShellArgs;
export type ShellExecResult = ShellResult["result"];
export type ShellExecResponse = ShellResult;
export type ShellExecutor = Executor<ShellExecutorArgs, ShellExecResponse>;

export const shellExecutorResource = createResource<ShellExecutor, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("shellArgs"), createClientDeserializer("shellResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("shellArgs"), createClientSerializer("shellResult"))),
);
