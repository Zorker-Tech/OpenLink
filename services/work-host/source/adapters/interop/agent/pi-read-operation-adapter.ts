/** Bind Pi read requests to their generated executor message cases. */

import type { PiReadExecArgs, PiReadExecResult } from "../proto/generated/agent/v1/pi_read_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const piReadExecutorResource = createResource<Executor<PiReadExecArgs, PiReadExecResult>, RemoteExecManager, ControlledExecManager>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("piReadArgs"),
    createClientDeserializer("piReadResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("piReadArgs"),
    createClientSerializer("piReadResult"),
  )),
);
