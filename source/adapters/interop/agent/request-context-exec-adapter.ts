/** Attach the request-context resource to its generated executor request and result cases. */

import type { RequestContextArgs, RequestContextResult } from "../proto/generated/agent/v1/request_context_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const requestContextExecutorResource = createResource<
  Executor<RequestContextArgs, RequestContextResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("requestContextArgs"),
    createClientDeserializer("requestContextResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("requestContextArgs"),
    createClientSerializer("requestContextResult"),
  )),
);
