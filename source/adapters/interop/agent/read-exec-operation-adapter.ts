/** Maps Slate's file-read contract to the generated execution frames at the transport boundary. */

import {
  ReadArgs,
  ReadError,
  ReadFileNotFound,
  ReadInvalidFile,
  ReadPermissionDenied,
  ReadRejected,
  ReadResult,
  ReadSuccess,
  type ReadSuccess as InteropReadSuccess,
  type ReadResult as InteropReadResult,
} from "../proto/generated/agent/v1/read_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import type {
  ReadExecutor,
  ReadExecutorArgs,
  ReadExecutorOutput,
  ReadExecutorResult,
} from "../../../packages/agent-exec/read-operation.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export function readExecutorArgsFromInterop(value: ReadArgs): ReadExecutorArgs {
  return {
    path: value.path,
    ...(value.toolCallId.length === 0 ? {} : { toolCallId: value.toolCallId }),
    ...(value.offset === undefined ? {} : { offset: value.offset }),
    ...(value.limit === undefined ? {} : { limit: value.limit }),
    ...(value.encodingHint === undefined ? {} : { encodingHint: value.encodingHint }),
  };
}

export function readExecutorArgsToInterop(value: ReadExecutorArgs): ReadArgs {
  return new ReadArgs({
    path: value.path,
    ...(value.toolCallId === undefined ? {} : { toolCallId: value.toolCallId }),
    ...(value.offset === undefined ? {} : { offset: value.offset }),
    ...(value.limit === undefined ? {} : { limit: value.limit }),
    ...(value.encodingHint === undefined ? {} : { encodingHint: value.encodingHint }),
  });
}

function readOutputFromInterop(value: InteropReadSuccess): ReadExecutorOutput | undefined {
  if (value.output.case === "content") return { kind: "text", text: value.output.value };
  if (value.output.case === "data") return { kind: "data", bytes: value.output.value };
  return undefined;
}

export function readExecutorResultFromInterop(value: InteropReadResult): ReadExecutorResult {
  switch (value.result.case) {
    case "success": {
      const output = readOutputFromInterop(value.result.value);
      return {
        kind: "success",
        path: value.result.value.path,
        ...(output === undefined ? {} : { output }),
        totalLines: value.result.value.totalLines,
        fileSize: value.result.value.fileSize,
        truncated: value.result.value.truncated,
        ...(value.result.value.outputBlobId === undefined ? {} : { outputBlobId: value.result.value.outputBlobId }),
        rangeApplied: value.result.value.rangeApplied,
      };
    }
    case "error":
      return { kind: "error", path: value.result.value.path, error: value.result.value.error };
    case "rejected":
      return { kind: "rejected", path: value.result.value.path, reason: value.result.value.reason };
    case "fileNotFound":
      return { kind: "not-found", path: value.result.value.path };
    case "permissionDenied":
      return { kind: "permission-denied", path: value.result.value.path };
    case "invalidFile":
      return { kind: "invalid-file", path: value.result.value.path, reason: value.result.value.reason };
    case undefined:
      return { kind: "unrecognized" };
  }
}

function readOutputToInterop(value: ReadExecutorOutput | undefined): ReadSuccess["output"] {
  if (value === undefined) return { case: undefined, value: undefined };
  return value.kind === "text"
    ? { case: "content", value: value.text }
    : { case: "data", value: value.bytes };
}

export function readExecutorResultToInterop(value: ReadExecutorResult): ReadResult {
  switch (value.kind) {
    case "success":
      return new ReadResult({ result: { case: "success", value: new ReadSuccess({
        path: value.path,
        output: readOutputToInterop(value.output),
        totalLines: value.totalLines,
        fileSize: value.fileSize,
        truncated: value.truncated,
        ...(value.outputBlobId === undefined ? {} : { outputBlobId: value.outputBlobId }),
        rangeApplied: value.rangeApplied,
      }) } });
    case "error":
      return new ReadResult({ result: { case: "error", value: new ReadError({ path: value.path, error: value.error }) } });
    case "rejected":
      return new ReadResult({ result: { case: "rejected", value: new ReadRejected({ path: value.path, reason: value.reason }) } });
    case "not-found":
      return new ReadResult({ result: { case: "fileNotFound", value: new ReadFileNotFound({ path: value.path }) } });
    case "permission-denied":
      return new ReadResult({ result: { case: "permissionDenied", value: new ReadPermissionDenied({ path: value.path }) } });
    case "invalid-file":
      return new ReadResult({ result: { case: "invalidFile", value: new ReadInvalidFile({ path: value.path, reason: value.reason }) } });
    case "unrecognized":
      return new ReadResult();
  }
}

function readResource(
  requestCase: "readArgs" | "redactedReadArgs",
  responseCase: "readResult" | "redactedReadResult",
) {
  return createResource<ReadExecutor, RemoteExecManager, ControlledExecManager>(
    manager => {
      const serializeArgs = createServerSerializer(requestCase);
      const deserializeResult = createClientDeserializer(responseCase);
      return new ExecutorResource(
        manager,
        (id, args: ReadExecutorArgs, options) => serializeArgs(id, readExecutorArgsToInterop(args), options),
        message => {
          const decoded = deserializeResult(message);
          return {
            value: decoded.value === undefined ? undefined : readExecutorResultFromInterop(decoded.value),
            ...(decoded.hookContexts === undefined ? {} : { hookContexts: decoded.hookContexts }),
          };
        },
      );
    },
    (implementation, manager) => {
      const interopImplementation: Executor<ReadArgs, ReadResult> = {
        async execute(ctx, args, options) {
          return readExecutorResultToInterop(await implementation.execute(ctx, readExecutorArgsFromInterop(args), options));
        },
      };
      manager.register(new SimpleControlledExecHandler(
        interopImplementation,
        createServerDeserializer(requestCase),
        createClientSerializer(responseCase),
      ));
    },
  );
}

/** A normal workspace read. */
export const readExecutorResource = readResource("readArgs", "readResult");

/** A privacy-filtered read, carried separately so its policy remains explicit. */
export const redactedReadExecutorResource = readResource("redactedReadArgs", "redactedReadResult");
