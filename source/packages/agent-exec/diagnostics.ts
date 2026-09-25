/**
 * The operation that reads diagnostics for the files a session is working on.
 *
 * Every operation has two sides that must not be wired up by hand: the client calls it, the host runs it, and
 * the resource is the name that introduces them. This module is that name for this operation, together with
 * whatever the operation needs to be called and answered.
 */

import { SimpleControlledExecHandler } from "./controlled-exec.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./executor-resources.ts";
import { createResource, type ControlledExecManager } from "./resource-provider.ts";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./exec-serialization.ts";
import type { DiagnosticsArgs, DiagnosticsResult } from "../proto/generated/agent/v1/diagnostics_exec_pb.ts";

export const diagnosticsExecutorResource = createResource<Executor<DiagnosticsArgs, DiagnosticsResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("diagnosticsArgs"), createClientDeserializer("diagnosticsResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("diagnosticsArgs"), createClientSerializer("diagnosticsResult"))),
);
