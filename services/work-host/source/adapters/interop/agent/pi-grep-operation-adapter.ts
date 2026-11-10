/** Bind Pi grep requests to their generated executor message cases. */

import type { PiGrepExecArgs, PiGrepExecResult } from "../proto/generated/agent/v1/pi_grep_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const piGrepExecutorResource = createResource<Executor<PiGrepExecArgs, PiGrepExecResult>, RemoteExecManager, ControlledExecManager>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("piGrepArgs"),
    createClientDeserializer("piGrepResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("piGrepArgs"),
    createClientSerializer("piGrepResult"),
  )),
);
