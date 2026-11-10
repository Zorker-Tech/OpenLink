import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
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
} from "../../source/adapters/interop/proto/generated/agent/v1/delete_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler, ControlledExecutor } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import {
  deleteExecutorArgsFromInterop,
  deleteExecutorArgsToInterop,
  deleteExecutorResource,
  deleteExecutorResultFromInterop,
  deleteExecutorResultToInterop,
} from "../../source/adapters/interop/agent/delete-operation-adapter.ts";
import type { DeleteExecutorArgs, DeleteExecutorResult } from "../../source/packages/agent-exec/delete.ts";

const context = createContext();
const args: DeleteExecutorArgs = { path: "/workspace/old.txt", toolCallId: "delete-1" };
const successfulDelete: DeleteExecutorResult = {
  kind: "success",
  path: args.path,
  deletedPath: args.path,
  fileSize: 4n,
  previousContent: "data",
};

test("Slate delete requests and every result retain their data through the transport adapter", () => {
  assert.deepEqual(deleteExecutorArgsFromInterop(deleteExecutorArgsToInterop(args)), args);
  const results: DeleteExecutorResult[] = [
    successfulDelete,
    { kind: "not-found", path: "/workspace/missing.txt" },
    { kind: "not-file", path: "/workspace/folder", actualType: "directory" },
    { kind: "permission-denied", path: args.path, message: "read only", isReadonly: true },
    { kind: "file-busy", path: args.path },
    { kind: "rejected", path: args.path, reason: "outside workspace" },
    { kind: "error", path: args.path, error: "disk error" },
    { kind: "unrecognized" },
  ];
  for (const result of results) assert.deepEqual(deleteExecutorResultFromInterop(deleteExecutorResultToInterop(result)), result);

  const wireFixtures = [
    [new DeleteResult({ result: { case: "success", value: new DeleteSuccess({ path: args.path, deletedFile: args.path, fileSize: 4n, prevContent: "data" }) } }), successfulDelete],
    [new DeleteResult({ result: { case: "fileNotFound", value: new DeleteFileNotFound({ path: args.path }) } }), { kind: "not-found", path: args.path }],
    [new DeleteResult({ result: { case: "notFile", value: new DeleteNotFile({ path: args.path, actualType: "directory" }) } }), { kind: "not-file", path: args.path, actualType: "directory" }],
    [new DeleteResult({ result: { case: "permissionDenied", value: new DeletePermissionDenied({ path: args.path, clientVisibleError: "read only", isReadonly: true }) } }), { kind: "permission-denied", path: args.path, message: "read only", isReadonly: true }],
    [new DeleteResult({ result: { case: "fileBusy", value: new DeleteFileBusy({ path: args.path }) } }), { kind: "file-busy", path: args.path }],
    [new DeleteResult({ result: { case: "rejected", value: new DeleteRejected({ path: args.path, reason: "outside workspace" }) } }), { kind: "rejected", path: args.path, reason: "outside workspace" }],
    [new DeleteResult({ result: { case: "error", value: new DeleteError({ path: args.path, error: "disk error" }) } }), { kind: "error", path: args.path, error: "disk error" }],
  ] as const;
  for (const [wire, expected] of wireFixtures) assert.deepEqual(deleteExecutorResultFromInterop(wire), expected);
  assert.deepEqual(deleteExecutorResultFromInterop(new DeleteResult()), { kind: "unrecognized" });
});

test("delete uses Slate values remotely and under controlled execution", async () => {
  const wireSuccess = deleteExecutorResultToInterop(successfulDelete);
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(111);
      return (async function* () {
        yield new ExecClientMessage({ id: 111, message: { case: "deleteResult", value: wireSuccess } });
      })();
    },
  };
  assert.deepEqual(await deleteExecutorResource.remoteImplementation(remote).execute(context, args), successfulDelete);
  assert.equal(outgoing?.message.case, "deleteArgs");
  if (outgoing?.message.case === "deleteArgs") assert.deepEqual(outgoing.message.value, deleteExecutorArgsToInterop(args));

  let handler: ControlledExecHandler | undefined;
  let received: DeleteExecutorArgs | undefined;
  const implementation: ControlledExecutor<DeleteExecutorArgs, DeleteExecutorResult> = {
    async execute(_ctx, request) { received = request; return successfulDelete; },
  };
  deleteExecutorResource.registerControlledImplementation(implementation, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 112, message: { case: "readArgs", value: {} } as never })), undefined);
  const stream = handler.handle(context, new ExecServerMessage({ id: 113, message: { case: "deleteArgs", value: new DeleteArgs(args) } }));
  assert.ok(stream);
  const responses: ExecClientMessage[] = [];
  for await (const response of stream) responses.push(response);
  assert.deepEqual(received, args);
  assert.equal(responses.length, 1);
  assert.equal(responses[0]?.message.case, "deleteResult");
  if (responses[0]?.message.case === "deleteResult") assert.deepEqual(responses[0].message.value, wireSuccess);
});
