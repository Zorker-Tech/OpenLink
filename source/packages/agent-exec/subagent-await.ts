/**
 * The operation that waits for a subagent to finish.
 *
 * Every operation has two sides that must not be wired up by hand: the client calls it, the host runs it, and
 * the resource is the name that introduces them. This module is that name for this operation, together with
 * whatever the operation needs to be called and answered.
 */

import { SimpleControlledExecHandler } from "./controlled-exec.ts";
import type { SubagentAwaitArgs, SubagentAwaitResult } from "../proto/generated/agent/v1/subagent_exec_pb.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./executor-resources.ts";
import { createResource, type ControlledExecManager } from "./resource-provider.ts";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./exec-serialization.ts";

export const subagentAwaitExecutorResource = createResource<Executor<SubagentAwaitArgs, SubagentAwaitResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("subagentAwaitArgs"), createClientDeserializer("subagentAwaitResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("subagentAwaitArgs"), createClientSerializer("subagentAwaitResult"))),
);
