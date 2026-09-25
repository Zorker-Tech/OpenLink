/**
 * The classifier operation, named so both sides can find it.
 *
 * Asking whether an action may run is a model call made where the action would happen, so it travels the
 * channel like any other operation. The timeouts and retries around it belong to the caller that measures
 * the call; this only introduces the two sides.
 */

import type {
  SmartModeClassifierArgs,
  SmartModeClassifierResult,
} from "../proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts"
import { SimpleControlledExecHandler } from "./controlled-exec.ts"
import { ExecutorResource, type Executor, type RemoteExecManager } from "./executor-resources.ts"
import { createResource, type ControlledExecManager } from "./resource-provider.ts"
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-serialization.ts"

export const smartModeClassifierExecutorResource = createResource<
  Executor<SmartModeClassifierArgs, SmartModeClassifierResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  execManager => new ExecutorResource(
    execManager,
    createServerSerializer("smartModeClassifierArgs"),
    createClientDeserializer("smartModeClassifierResult"),
  ),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("smartModeClassifierArgs"),
    createClientSerializer("smartModeClassifierResult"),
  )),
)
