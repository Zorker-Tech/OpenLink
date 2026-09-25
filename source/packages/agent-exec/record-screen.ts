/**
 * The operation that records the screen.
 *
 * Every operation has two sides that must not be wired up by hand: the client calls it, the host runs it, and
 * the resource is the name that introduces them. This module is that name for this operation, together with
 * whatever the operation needs to be called and answered.
 */

import { SimpleControlledExecHandler } from "./controlled-exec.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./executor-resources.ts";
import { createResource, type ControlledExecManager } from "./resource-provider.ts";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./exec-serialization.ts";
import type { RecordScreenArgs, RecordScreenResult } from "../proto/generated/agent/v1/record_screen_exec_pb.ts";

export const recordScreenExecutorResource = createResource<Executor<RecordScreenArgs, RecordScreenResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("recordScreenArgs"), createClientDeserializer("recordScreenResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("recordScreenArgs"), createClientSerializer("recordScreenResult"))),
);
