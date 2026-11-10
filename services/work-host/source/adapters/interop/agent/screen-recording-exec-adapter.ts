/** Route Slate's screen-recording resource through the counterpart executor message cases. */

import type { RecordScreenArgs, RecordScreenResult } from "../proto/generated/agent/v1/record_screen_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const recordScreenExecutorResource = createResource<
  Executor<RecordScreenArgs, RecordScreenResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("recordScreenArgs"),
    createClientDeserializer("recordScreenResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("recordScreenArgs"),
    createClientSerializer("recordScreenResult"),
  )),
);
