/** Bind hook execution to its generated executor request and result cases. */

import type { ExecuteHookArgs, ExecuteHookResult } from "../proto/generated/agent/v1/exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const hookExecutorResource = createResource<Executor<ExecuteHookArgs, ExecuteHookResult>, RemoteExecManager, ControlledExecManager>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("executeHookArgs"),
    createClientDeserializer("executeHookResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("executeHookArgs"),
    createClientSerializer("executeHookResult"),
  )),
);
