/** Bind executor diagnostics to their generated request and result cases. */

import type { DiagnosticsArgs, DiagnosticsResult } from "../proto/generated/agent/v1/diagnostics_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const diagnosticsExecutorResource = createResource<Executor<DiagnosticsArgs, DiagnosticsResult>, RemoteExecManager, ControlledExecManager>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("diagnosticsArgs"),
    createClientDeserializer("diagnosticsResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("diagnosticsArgs"),
    createClientSerializer("diagnosticsResult"),
  )),
);
