/** Connect the host's shell event stream to the counterpart executor envelope. */

import type { ShellArgs, ShellStream } from "../proto/generated/agent/v1/shell_exec_pb.ts";
import { SimpleControlledStreamExecHandler } from "./controlled-exec-manager-adapter.ts";
import { StreamExecutorResource, type RemoteExecManager, type StreamExecutor } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const shellStreamExecutorResource = createResource<
  StreamExecutor<ShellArgs, ShellStream>,
  RemoteExecManager,
  ControlledExecManager
>(
  (manager) => new StreamExecutorResource(
    manager,
    createServerSerializer("shellStreamArgs"),
    createClientDeserializer("shellStream"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledStreamExecHandler(
    implementation,
    createServerDeserializer("shellStreamArgs"),
    createClientSerializer("shellStream"),
  )),
);
