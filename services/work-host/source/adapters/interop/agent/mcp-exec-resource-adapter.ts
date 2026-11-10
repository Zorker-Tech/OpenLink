import type {
  ListMcpResourcesExecArgs,
  ListMcpResourcesExecResult,
  McpArgs,
  McpResult,
  McpStateExecArgs,
  McpStateExecResult,
  ReadMcpResourceExecArgs,
  ReadMcpResourceExecResult,
} from "../proto/generated/agent/v1/mcp_exec_pb.ts"
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts"
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts"
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts"
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts"

/** The executor resources that still speak the remote MCP operation envelope. */
export const mcpExecutorResource = createResource<Executor<McpArgs, McpResult>, RemoteExecManager, ControlledExecManager>(
  manager => new ExecutorResource(manager, createServerSerializer("mcpArgs"), createClientDeserializer("mcpResult")),
  (implementation, controlled) => controlled.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("mcpArgs"),
    createClientSerializer("mcpResult"),
  )),
)

export const listMcpResourcesExecutorResource = createResource<
  Executor<ListMcpResourcesExecArgs, ListMcpResourcesExecResult>, RemoteExecManager, ControlledExecManager
>(
  manager => new ExecutorResource(manager, createServerSerializer("listMcpResourcesExecArgs"), createClientDeserializer("listMcpResourcesExecResult")),
  (implementation, controlled) => controlled.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("listMcpResourcesExecArgs"),
    createClientSerializer("listMcpResourcesExecResult"),
  )),
)

export const readMcpResourceExecutorResource = createResource<
  Executor<ReadMcpResourceExecArgs, ReadMcpResourceExecResult>, RemoteExecManager, ControlledExecManager
>(
  manager => new ExecutorResource(manager, createServerSerializer("readMcpResourceExecArgs"), createClientDeserializer("readMcpResourceExecResult")),
  (implementation, controlled) => controlled.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("readMcpResourceExecArgs"),
    createClientSerializer("readMcpResourceExecResult"),
  )),
)

export const mcpStateExecutorResource = createResource<
  Executor<McpStateExecArgs, McpStateExecResult>, RemoteExecManager, ControlledExecManager
>(
  manager => new ExecutorResource(manager, createServerSerializer("mcpStateExecArgs"), createClientDeserializer("mcpStateExecResult")),
  (implementation, controlled) => controlled.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("mcpStateExecArgs"),
    createClientSerializer("mcpStateExecResult"),
  )),
)
