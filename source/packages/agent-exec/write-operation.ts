/**
 * The write operation, named so both sides can find it.
 *
 * Writing a file is one more operation on the exec channel: the client sends the arguments, the host
 * writes and answers with the result. This names it once so the two sides are introduced, and re-exports
 * the argument and result types so callers do not have to reach into the generated protos themselves.
 */

import type { WriteArgs, WriteResult } from "../proto/generated/agent/v1/write_exec_pb.ts"
import { SimpleControlledExecHandler } from "./controlled-exec.ts"
import { ExecutorResource, type Executor, type RemoteExecManager } from "./executor-resources.ts"
import { createResource, type ControlledExecManager } from "./resource-provider.ts"
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-serialization.ts"

export type WriteExecutorArgs = WriteArgs
export type WriteExecResult = WriteResult["result"]
export type WriteExecResponse = WriteResult
export type WriteExecutor = Executor<WriteExecutorArgs, WriteExecResponse>

export const writeExecutorResource = createResource<WriteExecutor, RemoteExecManager, ControlledExecManager>(
  execManager => new ExecutorResource(
    execManager,
    createServerSerializer("writeArgs"),
    createClientDeserializer("writeResult"),
  ),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("writeArgs"),
    createClientSerializer("writeResult"),
  )),
)
