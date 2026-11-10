/** Bridge web-fetch precheck resources to the counterpart executor message contract. */

import type { WebFetchAllowlistPrecheckArgs, WebFetchAllowlistPrecheckResult } from "../proto/generated/agent/v1/web_fetch_allowlist_precheck_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const webFetchAllowlistPrecheckExecutorResource = createResource<
  Executor<WebFetchAllowlistPrecheckArgs, WebFetchAllowlistPrecheckResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("webFetchAllowlistPrecheckArgs"),
    createClientDeserializer("webFetchAllowlistPrecheckResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("webFetchAllowlistPrecheckArgs"),
    createClientSerializer("webFetchAllowlistPrecheckResult"),
  )),
);
