/** Bind Pi edit requests to their generated executor message cases. */

import type { PiEditExecArgs, PiEditExecResult } from "../proto/generated/agent/v1/pi_edit_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const piEditExecutorResource = createResource<Executor<PiEditExecArgs, PiEditExecResult>, RemoteExecManager, ControlledExecManager>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("piEditArgs"),
    createClientDeserializer("piEditResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("piEditArgs"),
    createClientSerializer("piEditResult"),
  )),
);
