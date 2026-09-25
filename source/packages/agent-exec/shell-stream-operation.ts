/**
 * The shell operation, named so both sides can find it.
 *
 * A command's output arrives as a stream rather than as one answer, so this is the streaming variant of
 * the channel's client and host: the host yields every event the command produces and the client reads
 * them as they come, which is what lets output be shown while the command is still running.
 */

import type { ShellArgs, ShellStream } from "../proto/generated/agent/v1/shell_exec_pb.ts"
import { SimpleControlledStreamExecHandler } from "./controlled-exec.ts"
import { StreamExecutorResource, type RemoteExecManager, type StreamExecutor } from "./executor-resources.ts"
import { createResource, type ControlledExecManager } from "./resource-provider.ts"
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-serialization.ts"

export const shellStreamExecutorResource = createResource<
  StreamExecutor<ShellArgs, ShellStream>,
  RemoteExecManager,
  ControlledExecManager
>(
  execManager => new StreamExecutorResource(
    execManager,
    createServerSerializer("shellStreamArgs"),
    createClientDeserializer("shellStream"),
  ),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledStreamExecHandler(
    implementation,
    createServerDeserializer("shellStreamArgs"),
    createClientSerializer("shellStream"),
  )),
)
