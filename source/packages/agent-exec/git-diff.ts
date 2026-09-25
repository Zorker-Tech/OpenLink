/**
 * The operation that reads a git diff.
 *
 * Every operation has two sides that must not be wired up by hand: the client calls it, the host runs it, and
 * the resource is the name that introduces them. This module is that name for this operation, together with
 * whatever the operation needs to be called and answered.
 */

import { SimpleControlledExecHandler } from "./controlled-exec.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./executor-resources.ts";
import { createResource, type ControlledExecManager } from "./resource-provider.ts";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./exec-serialization.ts";
import type { GetDiffRequest, GetDiffResponse } from "../proto/generated/aiserver/v1/utils_pb.ts";

export const gitDiffExecutorResource = createResource<Executor<GetDiffRequest, GetDiffResponse>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("gitDiffRequest"), createClientDeserializer("gitDiffResponse")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("gitDiffRequest"), createClientSerializer("gitDiffResponse"))),
);
