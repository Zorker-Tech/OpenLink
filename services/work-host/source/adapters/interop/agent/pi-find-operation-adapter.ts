/** Bind Pi find requests to their generated executor message cases. */

import type { PiFindExecArgs, PiFindExecResult } from "../proto/generated/agent/v1/pi_find_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const piFindExecutorResource = createResource<Executor<PiFindExecArgs, PiFindExecResult>, RemoteExecManager, ControlledExecManager>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("piFindArgs"),
    createClientDeserializer("piFindResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("piFindArgs"),
    createClientSerializer("piFindResult"),
  )),
);
