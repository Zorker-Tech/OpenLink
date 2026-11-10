/** Maps Slate file writes to the generated execution frame at the transport boundary. */

import {
  WriteArgs,
  WriteError,
  WriteNoSpace,
  WritePermissionDenied,
  WriteRejected,
  WriteResult,
  WriteSuccess,
} from "../proto/generated/agent/v1/write_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type ExecutorOptions, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager, type ResourceAccessor } from "../../../packages/agent-exec/resource-provider.ts";
import type { Context } from "../../../packages/context/context.ts";
import type { HookContextEntry } from "../../../packages/hooks-carriers/hook-additional-context.ts";
import type {
  WriteExecResponse,
  WriteExecResult,
  WriteExecutor,
  WriteExecutorArgs,
  WriteExecutorResult,
} from "../../../packages/agent-exec/write-operation.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export function writeExecutorArgsFromInterop(value: WriteArgs): WriteExecutorArgs {
  const hasBytes = value.fileBytes.length > 0;
  return {
    path: value.path,
    ...(!hasBytes || value.fileText.length > 0 ? { text: value.fileText } : {}),
    ...(hasBytes ? { bytes: value.fileBytes } : {}),
    ...(value.toolCallId.length === 0 ? {} : { toolCallId: value.toolCallId }),
    ...(value.returnFileContentAfterWrite ? { includeContentAfterWrite: true } : {}),
    ...(value.encodingHint === undefined ? {} : { encoding: value.encodingHint }),
  };
}

export function writeExecutorArgsToInterop(value: WriteExecutorArgs): WriteArgs {
  return new WriteArgs({
    path: value.path,
    fileText: value.text ?? "",
    ...(value.bytes === undefined ? {} : { fileBytes: new Uint8Array(value.bytes) }),
    ...(value.toolCallId === undefined ? {} : { toolCallId: value.toolCallId }),
    ...(value.includeContentAfterWrite === undefined ? {} : { returnFileContentAfterWrite: value.includeContentAfterWrite }),
    ...(value.encoding === undefined ? {} : { encodingHint: value.encoding }),
  });
}

export function writeExecutorResultFromInterop(value: WriteResult): WriteExecutorResult {
  switch (value.result.case) {
    case "success":
      return {
        kind: "success",
        path: value.result.value.path,
        linesWritten: value.result.value.linesCreated,
        bytesWritten: value.result.value.fileSize,
        ...(value.result.value.fileContentAfterWrite === undefined
          ? {}
          : { contentAfterWrite: value.result.value.fileContentAfterWrite }),
      };
    case "permissionDenied":
      return {
        kind: "permission-denied",
        path: value.result.value.path,
        directory: value.result.value.directory,
        operation: value.result.value.operation,
        message: value.result.value.error,
        isReadonly: value.result.value.isReadonly,
      };
    case "noSpace":
      return { kind: "no-space", path: value.result.value.path };
    case "error":
      return { kind: "error", path: value.result.value.path, error: value.result.value.error };
    case "rejected":
      return { kind: "rejected", path: value.result.value.path, reason: value.result.value.reason };
    case undefined:
      return { kind: "unrecognized" };
  }
}

export function writeExecutorResultToInterop(value: WriteExecutorResult): WriteResult {
  switch (value.kind) {
    case "success":
      return new WriteResult({ result: { case: "success", value: new WriteSuccess({
        path: value.path,
        linesCreated: value.linesWritten,
        fileSize: value.bytesWritten,
        ...(value.contentAfterWrite === undefined ? {} : { fileContentAfterWrite: value.contentAfterWrite }),
      }) } });
    case "permission-denied":
      return new WriteResult({ result: { case: "permissionDenied", value: new WritePermissionDenied({
        path: value.path,
        directory: value.directory,
        operation: value.operation,
        error: value.message,
        isReadonly: value.isReadonly,
      }) } });
    case "no-space":
      return new WriteResult({ result: { case: "noSpace", value: new WriteNoSpace({ path: value.path }) } });
    case "error":
      return new WriteResult({ result: { case: "error", value: new WriteError({ path: value.path, error: value.error }) } });
    case "rejected":
      return new WriteResult({ result: { case: "rejected", value: new WriteRejected({ path: value.path, reason: value.reason }) } });
    case "unrecognized":
      return new WriteResult();
  }
}

export const writeExecutorResource = createResource<WriteExecutor, RemoteExecManager, ControlledExecManager>(
  (manager) => {
    const serializeArgs = createServerSerializer("writeArgs");
    const deserializeResult = createClientDeserializer("writeResult");
    return new ExecutorResource(
      manager,
      (id, args, options) => serializeArgs(id, writeExecutorArgsToInterop(args), options),
      (message) => {
        const decoded = deserializeResult(message);
        return {
          value: decoded.value === undefined ? undefined : writeExecutorResultFromInterop(decoded.value),
          ...(decoded.hookContexts === undefined ? {} : { hookContexts: decoded.hookContexts }),
        };
      },
    );
  },
  (implementation, manager) => {
    const interopImplementation: Executor<WriteArgs, WriteResult> = {
      async execute(ctx, args, options) {
        return writeExecutorResultToInterop(await implementation.execute(ctx, writeExecutorArgsFromInterop(args), options));
      },
    };
    manager.register(new SimpleControlledExecHandler(
      interopImplementation,
      createServerDeserializer("writeArgs"),
      createClientSerializer("writeResult"),
    ));
  },
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

function slateOutcomeFromWriteResult(result: WriteExecResult): WriteFileOutcome {
  switch (result.kind) {
    case "success":
      return { kind: "written", path: result.path };
    case "permission-denied":
      return { kind: "permission-denied", message: result.message, isReadonly: result.isReadonly };
    case "no-space":
      return { kind: "device-full" };
    case "rejected":
      return { kind: "user-rejected", reason: result.reason };
    case "error":
      return result.error.includes("Missing viewType for")
        ? { kind: "editor-unavailable", message: result.error }
        : { kind: "write-failed", message: result.error };
    case "unrecognized":
      return { kind: "unknown" };
  }
}

export async function writeFileThroughInterop(options: WriteFileThroughInteropOptions): Promise<WriteFileOutcome> {
  const args: WriteExecutorArgs = {
    path: options.path,
    text: options.content,
    toolCallId: options.toolCallId,
  };
  const executorOptions: ExecutorOptions = {
    execId: options.execId,
    ...(options.hookContextCollector === undefined ? {} : { hookContextCollector: options.hookContextCollector }),
    enableAgentStoreConflictNotices: options.enableConflictNotices,
  };
  const result: WriteExecResponse = await options.resources.get(writeExecutorResource).execute(options.context, args, executorOptions);
  return slateOutcomeFromWriteResult(result);
}
