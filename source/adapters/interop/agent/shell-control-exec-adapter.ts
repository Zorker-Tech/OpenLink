/** Bridge shell-control resources to the counterpart's executor message contract. */

import type { ForceBackgroundShellArgs, ForceBackgroundShellResult } from "../proto/generated/agent/v1/shell_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const forceBackgroundShellExecutorResource = createResource<
  Executor<ForceBackgroundShellArgs, ForceBackgroundShellResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("forceBackgroundShellArgs"),
    createClientDeserializer("forceBackgroundShellResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("forceBackgroundShellArgs"),
    createClientSerializer("forceBackgroundShellResult"),
  )),
);
