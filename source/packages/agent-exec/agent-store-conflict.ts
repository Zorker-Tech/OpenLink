/**
 * The operation that reads and resolves a conflict between this agent's store and another's.
 *
 * Every operation has two sides that must not be wired up by hand: the client calls it, the host runs it, and
 * the resource is the name that introduces them. This module is that name for this operation, together with
 * whatever the operation needs to be called and answered.
 */

import { SimpleControlledExecHandler } from "./controlled-exec.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./executor-resources.ts";
import { createResource, type ControlledExecManager } from "./resource-provider.ts";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./exec-serialization.ts";
import type { AgentStoreConflictArgs, AgentStoreConflictResult } from "../proto/generated/agent/v1/agent_store_conflict_exec_pb.ts";

export const agentStoreConflictExecutorResource = createResource<Executor<AgentStoreConflictArgs, AgentStoreConflictResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("agentStoreConflictArgs"), createClientDeserializer("agentStoreConflictResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("agentStoreConflictArgs"), createClientSerializer("agentStoreConflictResult"))),
);
