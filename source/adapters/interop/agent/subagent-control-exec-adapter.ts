/** Route subagent control requests through the counterpart executor message contract. */

import type { ForceBackgroundSubagentArgs, ForceBackgroundSubagentResult } from "../proto/generated/agent/v1/subagent_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const forceBackgroundSubagentExecutorResource = createResource<
  Executor<ForceBackgroundSubagentArgs, ForceBackgroundSubagentResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("forceBackgroundSubagentArgs"),
    createClientDeserializer("forceBackgroundSubagentResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("forceBackgroundSubagentArgs"),
    createClientSerializer("forceBackgroundSubagentResult"),
  )),
);
