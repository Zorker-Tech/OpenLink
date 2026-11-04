/** Bind path deletion to its generated executor request and result cases. */

import type { DeleteArgs, DeleteResult } from "../proto/generated/agent/v1/delete_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const deleteExecutorResource = createResource<Executor<DeleteArgs, DeleteResult>, RemoteExecManager, ControlledExecManager>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("deleteArgs"),
    createClientDeserializer("deleteResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("deleteArgs"),
    createClientSerializer("deleteResult"),
  )),
);
