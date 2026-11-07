import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { WriteArgs } from "../../source/adapters/interop/proto/generated/agent/v1/write_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler, ControlledExecutor } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import {
  writeExecutorArgsFromInterop,
  writeExecutorArgsToInterop,
  writeExecutorResource,
  writeExecutorResultFromInterop,
  writeExecutorResultToInterop,
  writeFileThroughInterop,
} from "../../source/adapters/interop/agent/write-operation-adapter.ts";
import type { WriteExecutorArgs, WriteExecutorResult } from "../../source/packages/agent-exec/write-operation.ts";

const context = createContext();

const successfulWrite: WriteExecutorResult = {
  kind: "success",
  path: "/workspace/note.txt",
  linesWritten: 1,
  bytesWritten: 5,
  contentAfterWrite: "hello",
};

test("Slate write arguments preserve text, bytes, options and simultaneous payloads", () => {
  const requests: WriteExecutorArgs[] = [
    { path: "/workspace/note.txt", text: "hello", toolCallId: "write-1", includeContentAfterWrite: true, encoding: "utf-8" },
    { path: "/workspace/image.png", bytes: new Uint8Array([1, 2, 3]), toolCallId: "write-2" },
    { path: "/workspace/empty.txt", text: "" },
    { path: "/workspace/both", text: "text", bytes: new Uint8Array([4]) },
  ];
  for (const request of requests) assert.deepEqual(writeExecutorArgsFromInterop(writeExecutorArgsToInterop(request)), request);
  assert.deepEqual(writeExecutorArgsFromInterop(new WriteArgs({ path: "/workspace/default.txt" })), {
    path: "/workspace/default.txt",
    text: "",
  });
});

test("Slate write results preserve success metadata and every failure case", () => {
  const results: WriteExecutorResult[] = [
    successfulWrite,
    { kind: "permission-denied", path: "/repo/readonly.txt", directory: "/repo", operation: "write", message: "read only", isReadonly: true },
    { kind: "no-space", path: "/repo/full.txt" },
    { kind: "error", path: "/repo/broken.txt", error: "disk failure" },
    { kind: "rejected", path: "/outside/file.txt", reason: "outside workspace" },
    { kind: "unrecognized" },
  ];
  for (const result of results) assert.deepEqual(writeExecutorResultFromInterop(writeExecutorResultToInterop(result)), result);
});

test("writes use the write transport case and expose Slate values remotely and under control", async () => {
  const expectedWire = writeExecutorResultToInterop(successfulWrite);
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(61);
      return (async function* () {
        yield new ExecClientMessage({ id: 61, message: { case: "writeResult", value: expectedWire } });
      })();
    },
  };

  const request: WriteExecutorArgs = { path: "/workspace/note.txt", text: "hello", toolCallId: "write-1" };
  assert.deepEqual(await writeExecutorResource.remoteImplementation(remote).execute(context, request), successfulWrite);
  assert.equal(outgoing?.message.case, "writeArgs");
  if (outgoing?.message.case === "writeArgs") assert.deepEqual(outgoing.message.value, writeExecutorArgsToInterop(request));

  let handler: ControlledExecHandler | undefined;
  let received: WriteExecutorArgs | undefined;
  const implementation: ControlledExecutor<WriteExecutorArgs, WriteExecutorResult> = {
    async execute(_ctx, args) {
      received = args;
      return successfulWrite;
    },
  };
  writeExecutorResource.registerControlledImplementation(implementation, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 62, message: { case: "shellArgs", value: {} } as never })), undefined);

  const stream = handler.handle(context, new ExecServerMessage({ id: 63, message: { case: "writeArgs", value: writeExecutorArgsToInterop(request) } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.deepEqual(received, request);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "writeResult");
  if (replies[0]?.message.case === "writeResult") assert.deepEqual(replies[0].message.value, expectedWire);
});

test("the file-write helper keeps Slate request data, executor options, and failure distinctions", async () => {
  const calls: Array<[WriteExecutorArgs, Record<string, unknown>]> = [];
  const collector: unknown[] = [];
  const successful = await writeFileThroughInterop({
    context,
    resources: {
      get(resource: unknown) {
        assert.equal(resource, writeExecutorResource);
        return {
          async execute(_context: unknown, args: WriteExecutorArgs, options: Record<string, unknown>) {
            calls.push([args, options]);
            return successfulWrite;
          },
        };
      },
    } as never,
    path: "/workspace/note.txt",
    content: "hello",
    toolCallId: "call-1",
    execId: "exec-1",
    hookContextCollector: collector as never,
    enableConflictNotices: true,
  });
  assert.deepEqual(successful, { kind: "written", path: "/workspace/note.txt" });
  assert.deepEqual(calls[0]?.[0], { path: "/workspace/note.txt", text: "hello", toolCallId: "call-1" });
  assert.equal(calls[0]?.[1].execId, "exec-1");
  assert.equal(calls[0]?.[1].hookContextCollector, collector);
  assert.equal(calls[0]?.[1].enableAgentStoreConflictNotices, true);

  const outcomes: Array<[WriteExecutorResult, unknown]> = [
    [{ kind: "permission-denied", path: "/workspace/note.txt", directory: "/workspace", operation: "write", message: "read only", isReadonly: true }, { kind: "permission-denied", message: "read only", isReadonly: true }],
    [{ kind: "no-space", path: "/workspace/note.txt" }, { kind: "device-full" }],
    [{ kind: "rejected", path: "/workspace/note.txt", reason: "not now" }, { kind: "user-rejected", reason: "not now" }],
    [{ kind: "error", path: "/workspace/note.txt", error: "Missing viewType for notebook" }, { kind: "editor-unavailable", message: "Missing viewType for notebook" }],
    [{ kind: "error", path: "/workspace/note.txt", error: "disk error" }, { kind: "write-failed", message: "disk error" }],
    [{ kind: "unrecognized" }, { kind: "unknown" }],
  ];
  for (const [result, expected] of outcomes) {
    const outcome = await writeFileThroughInterop({
      context,
      resources: { get: () => ({ execute: async () => result }) } as never,
      path: "/workspace/note.txt",
      content: "hello",
      toolCallId: "call-2",
      execId: "exec-2",
      enableConflictNotices: false,
    });
    assert.deepEqual(outcome, expected);
  }
});
