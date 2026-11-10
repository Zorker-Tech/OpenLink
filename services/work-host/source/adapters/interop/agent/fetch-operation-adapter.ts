/** Bind fetch operations to their generated executor request and result cases. */

import type { FetchArgs, FetchResult } from "../proto/generated/agent/v1/fetch_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const fetchExecutorResource = createResource<Executor<FetchArgs, FetchResult>, RemoteExecManager, ControlledExecManager>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("fetchArgs"),
    createClientDeserializer("fetchResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("fetchArgs"),
    createClientSerializer("fetchResult"),
  )),
);
