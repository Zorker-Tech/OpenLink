/** Bind agent-store conflict execution to its generated executor request and result cases. */

import type {
  AgentStoreConflictArgs,
  AgentStoreConflictResult,
} from "../proto/generated/agent/v1/agent_store_conflict_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const agentStoreConflictExecutorResource = createResource<
  Executor<AgentStoreConflictArgs, AgentStoreConflictResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("agentStoreConflictArgs"),
    createClientDeserializer("agentStoreConflictResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("agentStoreConflictArgs"),
    createClientSerializer("agentStoreConflictResult"),
  )),
);
