/** Bind classifier calls to the generated executor messages at the Agent protocol boundary. */

import type {
  SmartModeClassifierArgs,
  SmartModeClassifierResult,
} from "../proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts"
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts"
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts"
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts"
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts"

export type SmartModeClassifierExecutor = Executor<SmartModeClassifierArgs, SmartModeClassifierResult>

export const smartModeClassifierExecutorResource = createResource<
  SmartModeClassifierExecutor,
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
