/** Bind file writes to the generated executor request and result cases. */

import { WriteArgs, type WriteResult } from "../proto/generated/agent/v1/write_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type ExecutorOptions, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager, type ResourceAccessor } from "../../../packages/agent-exec/resource-provider.ts";
import type { Context } from "../../../packages/context/context.ts";
import type { HookContextEntry } from "../../../packages/hooks-carriers/hook-additional-context.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export type WriteExecutorArgs = WriteArgs;
export type WriteExecResult = WriteResult["result"];
export type WriteExecResponse = WriteResult;
export type WriteExecutor = Executor<WriteExecutorArgs, WriteExecResponse>;

export const writeExecutorResource = createResource<WriteExecutor, RemoteExecManager, ControlledExecManager>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("writeArgs"),
    createClientDeserializer("writeResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("writeArgs"),
    createClientSerializer("writeResult"),
  )),
);

export type WriteFileOutcome =
  | { readonly kind: "written"; readonly path: string }
  | { readonly kind: "permission-denied"; readonly message: string; readonly isReadonly: boolean }
  | { readonly kind: "device-full" }
  | { readonly kind: "user-rejected"; readonly reason: string }
  | { readonly kind: "editor-unavailable"; readonly message: string }
  | { readonly kind: "write-failed"; readonly message: string }
  | { readonly kind: "unknown" };

export interface WriteFileThroughInteropOptions {
  readonly context: Context;
  readonly resources: ResourceAccessor<RemoteExecManager>;
  readonly path: string;
  readonly content: string;
  readonly toolCallId: string;
  readonly execId: string;
  readonly hookContextCollector?: HookContextEntry[];
  readonly enableConflictNotices: boolean;
}

function slateOutcomeFromWireResult(result: WriteResult): WriteFileOutcome {
  switch (result.result.case) {
    case "success":
      return { kind: "written", path: result.result.value.path };
    case "permissionDenied":
      return {
        kind: "permission-denied",
        message: result.result.value.error,
        isReadonly: result.result.value.isReadonly,
      };
    case "noSpace":
      return { kind: "device-full" };
    case "rejected":
      return { kind: "user-rejected", reason: result.result.value.reason };
    case "error": {
      const message = result.result.value.error;
      return message.includes("Missing viewType for")
        ? { kind: "editor-unavailable", message }
        : { kind: "write-failed", message };
    }
    case undefined:
      return { kind: "unknown" };
  }
}

export async function writeFileThroughInterop(options: WriteFileThroughInteropOptions): Promise<WriteFileOutcome> {
  const args = new WriteArgs({
    path: options.path,
    fileText: options.content,
    toolCallId: options.toolCallId,
  });
  const executorOptions: ExecutorOptions = {
    execId: options.execId,
    ...(options.hookContextCollector === undefined ? {} : { hookContextCollector: options.hookContextCollector }),
    enableAgentStoreConflictNotices: options.enableConflictNotices,
  };
  const result = await options.resources.get(writeExecutorResource).execute(options.context, args, executorOptions);
  return slateOutcomeFromWireResult(result);
}
