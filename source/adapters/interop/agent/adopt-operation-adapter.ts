/** Bind adopted-work execution to its generated request and result cases. */

import type { AdoptArgs, AdoptResult } from "../proto/generated/agent/v1/adopt_tool_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const adoptExecutorResource = createResource<Executor<AdoptArgs, AdoptResult>, RemoteExecManager, ControlledExecManager>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("adoptArgs"),
    createClientDeserializer("adoptResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("adoptArgs"),
    createClientSerializer("adoptResult"),
  )),
);
