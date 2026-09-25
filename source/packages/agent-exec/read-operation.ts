/**
 * The read operations, named so both sides can find them.
 *
 * There are two of them, and the second is not a duplicate: a read may be asked for under a privacy mode
 * that redacts what it returns, and a redacted read travels under its own case in the protocol. Naming
 * both here is what keeps a caller from reaching for the ordinary read when it wanted the redacted one —
 * they are different operations with different message cases.
 */

import type { ReadArgs, ReadResult } from "../proto/generated/agent/v1/read_exec_pb.ts"
import { SimpleControlledExecHandler } from "./controlled-exec.ts"
import { ExecutorResource, type Executor, type RemoteExecManager } from "./executor-resources.ts"
import { createResource, type ControlledExecManager } from "./resource-provider.ts"
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-serialization.ts"

export type ReadExecutorArgs = ReadArgs
export type ReadExecutor = Executor<ReadExecutorArgs, ReadResult>

export const readExecutorResource = createResource<ReadExecutor, RemoteExecManager, ControlledExecManager>(
  execManager => new ExecutorResource(
    execManager,
    createServerSerializer("readArgs"),
    createClientDeserializer("readResult"),
  ),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("readArgs"),
    createClientSerializer("readResult"),
  )),
)

export const redactedReadExecutorResource = createResource<Executor<ReadArgs, ReadResult>, RemoteExecManager, ControlledExecManager>(
  execManager => new ExecutorResource(
    execManager,
    createServerSerializer("redactedReadArgs"),
    createClientDeserializer("redactedReadResult"),
  ),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("redactedReadArgs"),
    createClientSerializer("redactedReadResult"),
  )),
)
