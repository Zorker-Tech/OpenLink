/** Maps Slate file deletion requests and outcomes to the generated transport frame. */

import {
  DeleteArgs,
  DeleteError,
  DeleteFileBusy,
  DeleteFileNotFound,
  DeleteNotFile,
  DeletePermissionDenied,
  DeleteRejected,
  DeleteResult,
  DeleteSuccess,
} from "../proto/generated/agent/v1/delete_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import type { DeleteExecutor, DeleteExecutorArgs, DeleteExecutorResult } from "../../../packages/agent-exec/delete.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export function deleteExecutorArgsFromInterop(value: DeleteArgs): DeleteExecutorArgs {
  return {
    path: value.path,
    ...(value.toolCallId.length === 0 ? {} : { toolCallId: value.toolCallId }),
  };
}

export function deleteExecutorArgsToInterop(value: DeleteExecutorArgs): DeleteArgs {
  return new DeleteArgs({
    path: value.path,
    ...(value.toolCallId === undefined ? {} : { toolCallId: value.toolCallId }),
  });
}

export function deleteExecutorResultFromInterop(value: DeleteResult): DeleteExecutorResult {
  switch (value.result.case) {
    case "success":
      return {
        kind: "success",
        path: value.result.value.path,
        deletedPath: value.result.value.deletedFile,
        fileSize: value.result.value.fileSize,
        previousContent: value.result.value.prevContent,
      };
    case "fileNotFound":
      return { kind: "not-found", path: value.result.value.path };
    case "notFile":
      return { kind: "not-file", path: value.result.value.path, actualType: value.result.value.actualType };
    case "permissionDenied":
      return {
        kind: "permission-denied",
        path: value.result.value.path,
        message: value.result.value.clientVisibleError,
        isReadonly: value.result.value.isReadonly,
      };
    case "fileBusy":
      return { kind: "file-busy", path: value.result.value.path };
    case "rejected":
      return { kind: "rejected", path: value.result.value.path, reason: value.result.value.reason };
    case "error":
      return { kind: "error", path: value.result.value.path, error: value.result.value.error };
    case undefined:
      return { kind: "unrecognized" };
  }
}

export function deleteExecutorResultToInterop(value: DeleteExecutorResult): DeleteResult {
  switch (value.kind) {
    case "success":
      return new DeleteResult({ result: { case: "success", value: new DeleteSuccess({
        path: value.path,
        deletedFile: value.deletedPath,
        fileSize: value.fileSize,
        prevContent: value.previousContent,
      }) } });
    case "not-found":
      return new DeleteResult({ result: { case: "fileNotFound", value: new DeleteFileNotFound({ path: value.path }) } });
    case "not-file":
      return new DeleteResult({ result: { case: "notFile", value: new DeleteNotFile({ path: value.path, actualType: value.actualType }) } });
    case "permission-denied":
      return new DeleteResult({ result: { case: "permissionDenied", value: new DeletePermissionDenied({
        path: value.path,
        clientVisibleError: value.message,
        isReadonly: value.isReadonly,
      }) } });
    case "file-busy":
      return new DeleteResult({ result: { case: "fileBusy", value: new DeleteFileBusy({ path: value.path }) } });
    case "rejected":
      return new DeleteResult({ result: { case: "rejected", value: new DeleteRejected({ path: value.path, reason: value.reason }) } });
    case "error":
      return new DeleteResult({ result: { case: "error", value: new DeleteError({ path: value.path, error: value.error }) } });
    case "unrecognized":
      return new DeleteResult();
  }
}

export const deleteExecutorResource = createResource<DeleteExecutor, RemoteExecManager, ControlledExecManager>(
  (manager) => {
    const serializeArgs = createServerSerializer("deleteArgs");
    const deserializeResult = createClientDeserializer("deleteResult");
    return new ExecutorResource(
      manager,
      (id, args, options) => serializeArgs(id, deleteExecutorArgsToInterop(args), options),
      (message) => {
        const decoded = deserializeResult(message);
        return {
          value: decoded.value === undefined ? undefined : deleteExecutorResultFromInterop(decoded.value),
          ...(decoded.hookContexts === undefined ? {} : { hookContexts: decoded.hookContexts }),
        };
      },
    );
  },
  (implementation, manager) => {
    const interopImplementation: Executor<DeleteArgs, DeleteResult> = {
      async execute(ctx, args, options) {
        return deleteExecutorResultToInterop(await implementation.execute(ctx, deleteExecutorArgsFromInterop(args), options));
      },
    };
    manager.register(new SimpleControlledExecHandler(
      interopImplementation,
      createServerDeserializer("deleteArgs"),
      createClientSerializer("deleteResult"),
    ));
  },
);
