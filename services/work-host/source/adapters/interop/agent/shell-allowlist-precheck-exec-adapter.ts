/** Bridge shell precheck resources to the counterpart's executor message contract. */

import type { ShellAllowlistPrecheckArgs, ShellAllowlistPrecheckResult } from "../proto/generated/agent/v1/shell_allowlist_precheck_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const shellAllowlistPrecheckExecutorResource = createResource<
  Executor<ShellAllowlistPrecheckArgs, ShellAllowlistPrecheckResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("shellAllowlistPrecheckArgs"),
    createClientDeserializer("shellAllowlistPrecheckResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("shellAllowlistPrecheckArgs"),
    createClientSerializer("shellAllowlistPrecheckResult"),
  )),
);
