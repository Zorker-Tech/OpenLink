/**
 * The operation that adopts work a previous run left behind, named so both ends of the exec channel can find it.
 *
 * Every operation has two sides that must not be wired up by hand: the client calls it, the host runs it, and
 * the resource is the name that introduces them. This module is that name for this operation, together with
 * whatever the operation needs to be called and answered.
 */

import { SimpleControlledExecHandler } from "./controlled-exec.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./executor-resources.ts";
import { createResource, type ControlledExecManager } from "./resource-provider.ts";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./exec-serialization.ts";
import type { AdoptArgs, AdoptResult } from "../proto/generated/agent/v1/adopt_tool_pb.ts";

export const adoptExecutorResource = createResource<Executor<AdoptArgs, AdoptResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("adoptArgs"), createClientDeserializer("adoptResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("adoptArgs"), createClientSerializer("adoptResult"))),
);
