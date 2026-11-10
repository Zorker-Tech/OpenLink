/** Bind Pi Bash requests to their generated executor message cases. */

import type { PiBashExecArgs, PiBashExecResult } from "../proto/generated/agent/v1/pi_bash_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const piBashExecutorResource = createResource<Executor<PiBashExecArgs, PiBashExecResult>, RemoteExecManager, ControlledExecManager>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("piBashArgs"),
    createClientDeserializer("piBashResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("piBashArgs"),
    createClientSerializer("piBashResult"),
  )),
);
