import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { ReadArgs, ReadResult, ReadSuccess } from "../../source/adapters/interop/proto/generated/agent/v1/read_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler, ControlledExecutor } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import {
  readExecutorResource,
  redactedReadExecutorResource,
  readExecutorResultFromInterop,
} from "../../source/adapters/interop/agent/read-exec-operation-adapter.ts";
import type { Resource, ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { Executor, RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import type { ReadExecutorArgs, ReadExecutorResult } from "../../source/packages/agent-exec/read-operation.ts";

const context = createContext();

function readResult(): ReadResult {
  return new ReadResult({
    result: {
      case: "success",
      value: new ReadSuccess({
        path: "/workspace/notes.txt",
        output: { case: "content", value: "independent result" },
        totalLines: 1,
      }),
    },
  });
}

async function assertRemotePair(
  resource: Resource<Executor<ReadExecutorArgs, ReadExecutorResult>, RemoteExecManager, ControlledExecManager>,
  argsCase: "readArgs" | "redactedReadArgs",
  resultCase: "readResult" | "redactedReadResult",
): Promise<void> {
  const expected = readResult();
  let outgoing: ExecServerMessage | undefined;
  const manager: RemoteExecManager = {
    createExecInstance(_ctx, createMessage) {
      outgoing = createMessage(41);
      return (async function* () {
        yield new ExecClientMessage({
          id: 41,
          message: { case: resultCase, value: expected },
        });
      })();
    },
  };
  const executor = resource.remoteImplementation(manager);
  const args: ReadExecutorArgs = { path: "/workspace/notes.txt", toolCallId: "call-41" };

  assert.deepEqual(await executor.execute(context, args), readExecutorResultFromInterop(expected));
  assert.equal(outgoing?.message.case, argsCase);
  if (outgoing?.message.case === argsCase) {
    assert.deepEqual(outgoing.message.value, new ReadArgs({
      path: args.path,
      ...(args.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }),
    }));
  }
}

async function assertControlledPair(
  resource: Resource<Executor<ReadExecutorArgs, ReadExecutorResult>, RemoteExecManager, ControlledExecManager>,
  requestCase: "readArgs" | "redactedReadArgs",
  otherRequestCase: "readArgs" | "redactedReadArgs",
  resultCase: "readResult" | "redactedReadResult",
): Promise<void> {
  const expected = readResult();
  const expectedSlate = readExecutorResultFromInterop(expected);
  let handler: ControlledExecHandler | undefined;
  let received: ReadExecutorArgs | undefined;
  const implementation: ControlledExecutor<ReadExecutorArgs, ReadExecutorResult> = {
    async execute(_ctx, args) {
      received = args;
      return expectedSlate;
    },
  };
  resource.registerControlledImplementation(implementation, {
    register(value) {
      handler = value as ControlledExecHandler;
    },
  });
  assert.ok(handler);

  const request: ReadExecutorArgs = { path: "/workspace/notes.txt", toolCallId: "call-42" };
  const interopRequest = new ReadArgs({
    path: request.path,
    ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
  });
  const other = new ExecServerMessage({ id: 42, message: { case: otherRequestCase, value: interopRequest } });
  assert.equal(handler.handle(context, other), undefined);

  const matching = new ExecServerMessage({ id: 42, message: { case: requestCase, value: interopRequest } });
  const stream = handler.handle(context, matching);
  assert.ok(stream);
  const messages: ExecClientMessage[] = [];
  for await (const message of stream) messages.push(message);

  assert.deepEqual(received, request);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.message.case, resultCase);
  if (messages[0]?.message.case === resultCase) assert.deepEqual(messages[0].message.value, expected);
}

test("ordinary reads use only the ordinary transport cases around Slate values", async () => {
  await assertRemotePair(readExecutorResource, "readArgs", "readResult");
  await assertControlledPair(readExecutorResource, "readArgs", "redactedReadArgs", "readResult");
});

test("redacted reads use only the redacted transport cases around Slate values", async () => {
  await assertRemotePair(redactedReadExecutorResource, "redactedReadArgs", "redactedReadResult");
  await assertControlledPair(redactedReadExecutorResource, "redactedReadArgs", "readArgs", "redactedReadResult");
});

test("ordinary and redacted reads remain distinct resources", () => {
  assert.notEqual(readExecutorResource.symbol, redactedReadExecutorResource.symbol);
});
