/**
 * The hook operation, named so both sides can find it.
 *
 * A hook is executed like any other operation on the exec channel: the client sends the hook's
 * arguments, the host runs the hook and answers with its result. This is the resource that introduces
 * the two sides — the client's side built over the manager that talks to the host, the host's side
 * registered with the manager that serves it — and the name other modules refer to when they ask for
 * the hook executor.
 */

import type { ExecuteHookArgs, ExecuteHookResult } from "../proto/generated/agent/v1/exec_pb.ts"
import { SimpleControlledExecHandler } from "./controlled-exec.ts"
import { ExecutorResource, type Executor, type RemoteExecManager } from "./executor-resources.ts"
import { createResource, type ControlledExecManager } from "./resource-provider.ts"
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-serialization.ts"

export const hookExecutorResource = createResource<
  Executor<ExecuteHookArgs, ExecuteHookResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  execManager => new ExecutorResource(
    execManager,
    createServerSerializer("executeHookArgs"),
    createClientDeserializer("executeHookResult"),
  ),
  (implementation, controlledExecManager) => controlledExecManager.register(
    new SimpleControlledExecHandler(
      implementation,
      createServerDeserializer("executeHookArgs"),
      createClientSerializer("executeHookResult"),
    ),
  ),
)
