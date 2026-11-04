import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import {
  WriteArgs,
  WriteError,
  WriteNoSpace,
  WritePermissionDenied,
  WriteRejected,
  WriteResult,
  WriteSuccess,
} from "../../source/adapters/interop/proto/generated/agent/v1/write_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import {
  writeExecutorResource,
  writeFileThroughInterop,
} from "../../source/adapters/interop/agent/write-operation-adapter.ts";

const context = createContext();

test("file writes are carried in the write-specific request and result cases", async () => {
  const args = new WriteArgs({ path: "/workspace/note.txt", fileText: "hello", toolCallId: "write-1" });
  const expected = new WriteResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(61);
      return (async function* () {
        yield new ExecClientMessage({ id: 61, message: { case: "writeResult", value: expected } });
      })();
    },
  };

  assert.equal(await writeExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "writeArgs");
  if (outgoing?.message.case === "writeArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  writeExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 62, message: { case: "shellArgs", value: {} } as never })), undefined);

  const stream = handler.handle(context, new ExecServerMessage({ id: 63, message: { case: "writeArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "writeResult");
  if (replies[0]?.message.case === "writeResult") assert.deepEqual(replies[0].message.value, expected);
});

test("the write adapter maps arguments, execution options, and each result into Slate outcomes", async () => {
  const calls: unknown[] = [];
  const collector: unknown[] = [];
  const successful = await writeFileThroughInterop({
    context,
    resources: {
      get(resource: unknown) {
        assert.equal(resource, writeExecutorResource);
        return {
          async execute(_context: unknown, args: WriteArgs, options: Record<string, unknown>) {
            calls.push([args, options]);
            return new WriteResult({
              result: { case: "success", value: new WriteSuccess({ path: "/workspace/note.txt" }) },
            });
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
  const captured = calls[0] as [WriteArgs, Record<string, unknown>];
  assert.deepEqual([captured[0].path, captured[0].fileText, captured[0].toolCallId], ["/workspace/note.txt", "hello", "call-1"]);
  assert.equal(captured[1].execId, "exec-1");
  assert.equal(captured[1].hookContextCollector, collector);
  assert.equal(captured[1].enableAgentStoreConflictNotices, true);

  const outcomes = [
    [new WriteResult({ result: { case: "permissionDenied", value: new WritePermissionDenied({ error: "read only", isReadonly: true }) } }), { kind: "permission-denied", message: "read only", isReadonly: true }],
    [new WriteResult({ result: { case: "noSpace", value: new WriteNoSpace() } }), { kind: "device-full" }],
    [new WriteResult({ result: { case: "rejected", value: new WriteRejected({ reason: "not now" }) } }), { kind: "user-rejected", reason: "not now" }],
    [new WriteResult({ result: { case: "error", value: new WriteError({ error: "Missing viewType for notebook" }) } }), { kind: "editor-unavailable", message: "Missing viewType for notebook" }],
    [new WriteResult({ result: { case: "error", value: new WriteError({ error: "disk error" }) } }), { kind: "write-failed", message: "disk error" }],
    [new WriteResult(), { kind: "unknown" }],
  ] as const;
  for (const [wireResult, expected] of outcomes) {
    const outcome = await writeFileThroughInterop({
      context,
      resources: { get: () => ({ execute: async () => wireResult }) } as never,
      path: "/workspace/note.txt",
      content: "hello",
      toolCallId: "call-2",
      execId: "exec-2",
      enableConflictNotices: false,
    });
    assert.deepEqual(outcome, expected);
  }
});
