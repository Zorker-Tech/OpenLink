/** Bind the delegated Bash operation to its generated executor message cases. */

import type { ShellArgs, ShellResult } from "../proto/generated/agent/v1/shell_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const miniSweAgentBashExecutorResource = createResource<Executor<ShellArgs, ShellResult>, RemoteExecManager, ControlledExecManager>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("miniSweAgentBashArgs"),
    createClientDeserializer("miniSweAgentBashResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("miniSweAgentBashArgs"),
    createClientSerializer("miniSweAgentBashResult"),
  )),
);
