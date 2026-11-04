/** Bind git-diff requests to their generated executor message cases. */

import type { GetDiffRequest, GetDiffResponse } from "../proto/generated/aiserver/v1/utils_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const gitDiffExecutorResource = createResource<Executor<GetDiffRequest, GetDiffResponse>, RemoteExecManager, ControlledExecManager>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("gitDiffRequest"),
    createClientDeserializer("gitDiffResponse"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("gitDiffRequest"),
    createClientSerializer("gitDiffResponse"),
  )),
);
