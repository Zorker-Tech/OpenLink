/** Connect Slate's file-writing resource to the counterpart executor's wire messages. */

import type { PiWriteExecArgs, PiWriteExecResult } from "../proto/generated/agent/v1/pi_write_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const agentFileWriteExecutorResource = createResource<
  Executor<PiWriteExecArgs, PiWriteExecResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("piWriteArgs"),
    createClientDeserializer("piWriteResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("piWriteArgs"),
    createClientSerializer("piWriteResult"),
  )),
);
