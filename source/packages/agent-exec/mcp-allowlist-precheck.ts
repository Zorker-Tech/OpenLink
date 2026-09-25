/**
 * The precheck that decides whether an MCP call may proceed before the call is made.
 *
 * Every operation has two sides that must not be wired up by hand: the client calls it, the host runs it, and
 * the resource is the name that introduces them. This module is that name for this operation, together with
 * whatever the operation needs to be called and answered.
 */

import { SimpleControlledExecHandler } from "./controlled-exec.ts";
import type { McpAllowlistPrecheckArgs, McpAllowlistPrecheckResult } from "../proto/generated/agent/v1/mcp_allowlist_precheck_exec_pb.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./executor-resources.ts";
import { createResource, type ControlledExecManager } from "./resource-provider.ts";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./exec-serialization.ts";

export const mcpAllowlistPrecheckExecutorResource = createResource<Executor<McpAllowlistPrecheckArgs, McpAllowlistPrecheckResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("mcpAllowlistPrecheckArgs"), createClientDeserializer("mcpAllowlistPrecheckResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("mcpAllowlistPrecheckArgs"), createClientSerializer("mcpAllowlistPrecheckResult"))),
);
