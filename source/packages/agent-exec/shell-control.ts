/**
 * The operation that moves a running shell to the background, or brings it back.
 *
 * Every operation has two sides that must not be wired up by hand: the client calls it, the host runs it, and
 * the resource is the name that introduces them. This module is that name for this operation, together with
 * whatever the operation needs to be called and answered.
 */

import { SimpleControlledExecHandler } from "./controlled-exec.ts";
import type { ForceBackgroundShellArgs, ForceBackgroundShellResult } from "../proto/generated/agent/v1/shell_exec_pb.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./executor-resources.ts";
import { createResource, type ControlledExecManager } from "./resource-provider.ts";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./exec-serialization.ts";

export const forceBackgroundShellExecutorResource = createResource<Executor<ForceBackgroundShellArgs, ForceBackgroundShellResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("forceBackgroundShellArgs"), createClientDeserializer("forceBackgroundShellResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("forceBackgroundShellArgs"), createClientSerializer("forceBackgroundShellResult"))),
);
