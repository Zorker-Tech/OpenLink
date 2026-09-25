/**
 * Building a request's context, where the request is going to run.
 *
 * A conversation's context — which files, rules and skills belong to the request, and what the
 * workspace looks like — is assembled from things only the workspace can see. So it is an operation on
 * the exec channel like any other: this names it once so the two sides are introduced, and the result
 * comes back as a message the caller already knows how to read.
 */

import type { RequestContextArgs, RequestContextResult } from "../proto/generated/agent/v1/request_context_exec_pb.ts"
import { SimpleControlledExecHandler } from "./controlled-exec.ts"
import { ExecutorResource, type Executor, type RemoteExecManager } from "./executor-resources.ts"
import { createResource, type ControlledExecManager } from "./resource-provider.ts"
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-serialization.ts"

export const requestContextExecutorResource = createResource<
  Executor<RequestContextArgs, RequestContextResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  execManager => new ExecutorResource(
    execManager,
    createServerSerializer("requestContextArgs"),
    createClientDeserializer("requestContextResult"),
  ),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("requestContextArgs"),
    createClientSerializer("requestContextResult"),
  )),
)
