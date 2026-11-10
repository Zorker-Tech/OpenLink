/** Bind MCP allowlist prechecks to their generated executor request and result cases. */

import type {
  McpAllowlistPrecheckArgs,
  McpAllowlistPrecheckResult,
} from "../proto/generated/agent/v1/mcp_allowlist_precheck_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const mcpAllowlistPrecheckExecutorResource = createResource<
  Executor<McpAllowlistPrecheckArgs, McpAllowlistPrecheckResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("mcpAllowlistPrecheckArgs"),
    createClientDeserializer("mcpAllowlistPrecheckResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("mcpAllowlistPrecheckArgs"),
    createClientSerializer("mcpAllowlistPrecheckResult"),
  )),
);
