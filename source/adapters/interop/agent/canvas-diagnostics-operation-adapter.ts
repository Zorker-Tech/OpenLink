/** Bind canvas diagnostics to their generated executor request and result cases. */

import { CanvasDiagnosticsArgs, type CanvasDiagnosticsResult } from "../proto/generated/agent/v1/canvas_diagnostics_exec_pb.ts";
import { DiagnosticSeverity, type Diagnostic } from "../proto/generated/agent/v1/diagnostics_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager, type ResourceAccessor } from "../../../packages/agent-exec/resource-provider.ts";
import type { Context } from "../../../packages/context/context.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const canvasDiagnosticsExecutorResource = createResource<
  Executor<CanvasDiagnosticsArgs, CanvasDiagnosticsResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("canvasDiagnosticsArgs"),
    createClientDeserializer("canvasDiagnosticsResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("canvasDiagnosticsArgs"),
    createClientSerializer("canvasDiagnosticsResult"),
  )),
);

export type SlateCanvasDiagnosticSeverity = "error" | "warning" | "other";

export interface SlateCanvasDiagnostic {
  readonly severity: SlateCanvasDiagnosticSeverity;
  readonly message: string;
  readonly line: number;
  readonly column: number;
  readonly source?: string;
}

export interface SlateCanvasDiagnosticsSnapshot {
  readonly path: string;
  readonly diagnostics: readonly SlateCanvasDiagnostic[];
}

export interface SlateCanvasDiagnosticsReader {
  read(context: Context, path: string, toolCallId: string): Promise<SlateCanvasDiagnosticsSnapshot | undefined>;
}

function diagnosticForSlate(diagnostic: Diagnostic): SlateCanvasDiagnostic {
  const severity: SlateCanvasDiagnosticSeverity = diagnostic.severity === DiagnosticSeverity.ERROR
    ? "error"
    : diagnostic.severity === DiagnosticSeverity.WARNING ? "warning" : "other";
  return {
    severity,
    message: diagnostic.message,
    line: diagnostic.range?.start?.line ?? 0,
    column: diagnostic.range?.start?.column ?? 0,
    ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
  };
}

/** Opens the generated diagnostics executor and projects its response to Slate's display contract. */
export function canvasDiagnosticsReaderFromResources(
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
): SlateCanvasDiagnosticsReader | undefined {
  let executor: Executor<CanvasDiagnosticsArgs, CanvasDiagnosticsResult>;
  try {
    executor = resourceAccessor.get(canvasDiagnosticsExecutorResource);
  } catch {
    return undefined;
  }
  return {
    async read(context, path, toolCallId) {
      const result = await executor.execute(context, new CanvasDiagnosticsArgs({ path, toolCallId }));
      if (result.result.case !== "success") return undefined;
      return {
        path: result.result.value.path,
        diagnostics: result.result.value.diagnostics.map(diagnosticForSlate),
      };
    },
  };
}
