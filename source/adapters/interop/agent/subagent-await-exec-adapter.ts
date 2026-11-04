/** Route subagent wait requests through the counterpart executor message contract. */

import type { SubagentAwaitArgs, SubagentAwaitResult } from "../proto/generated/agent/v1/subagent_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const subagentAwaitExecutorResource = createResource<
  Executor<SubagentAwaitArgs, SubagentAwaitResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("subagentAwaitArgs"),
    createClientDeserializer("subagentAwaitResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("subagentAwaitArgs"),
    createClientSerializer("subagentAwaitResult"),
  )),
);
