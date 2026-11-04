import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { ReadArgs, ReadResult, ReadSuccess } from "../../source/adapters/interop/proto/generated/agent/v1/read_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler, ControlledExecutor } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import {
  readExecutorResource,
  redactedReadExecutorResource,
} from "../../source/adapters/interop/agent/read-exec-operation-adapter.ts";
import type { Resource } from "../../source/packages/agent-exec/resource-provider.ts";
import type { Executor, RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";

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
  resource: Resource<Executor<ReadArgs, ReadResult>, RemoteExecManager, never>,
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
  const args = new ReadArgs({ path: "/workspace/notes.txt", toolCallId: "call-41" });

  assert.equal(await executor.execute(context, args), expected);
  assert.equal(outgoing?.message.case, argsCase);
  if (outgoing?.message.case === argsCase) assert.deepEqual(outgoing.message.value, args);
}

async function assertControlledPair(
  resource: Resource<Executor<ReadArgs, ReadResult>, never, { register(handler: unknown): void }>,
  requestCase: "readArgs" | "redactedReadArgs",
  otherRequestCase: "readArgs" | "redactedReadArgs",
  resultCase: "readResult" | "redactedReadResult",
): Promise<void> {
  const expected = readResult();
  let handler: ControlledExecHandler | undefined;
  let received: ReadArgs | undefined;
  const implementation: ControlledExecutor<ReadArgs, ReadResult> = {
    async execute(_ctx, args) {
      received = args;
      return expected;
    },
  };
  resource.registerControlledImplementation(implementation, {
    register(value) {
      handler = value as ControlledExecHandler;
    },
  });
  assert.ok(handler);

  const request = new ReadArgs({ path: "/workspace/notes.txt", toolCallId: "call-42" });
  const other = new ExecServerMessage({ id: 42, message: { case: otherRequestCase, value: request } });
  assert.equal(handler.handle(context, other), undefined);

  const matching = new ExecServerMessage({ id: 42, message: { case: requestCase, value: request } });
  const stream = handler.handle(context, matching);
  assert.ok(stream);
  const messages: ExecClientMessage[] = [];
  for await (const message of stream) messages.push(message);

  assert.equal(received, request);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.message.case, resultCase);
  if (messages[0]?.message.case === resultCase) assert.deepEqual(messages[0].message.value, expected);
}

test("ordinary reads use only the ordinary request and response cases", async () => {
  await assertRemotePair(readExecutorResource, "readArgs", "readResult");
  await assertControlledPair(readExecutorResource, "readArgs", "redactedReadArgs", "readResult");
});

test("redacted reads use only the redacted request and response cases", async () => {
  await assertRemotePair(redactedReadExecutorResource, "redactedReadArgs", "redactedReadResult");
  await assertControlledPair(redactedReadExecutorResource, "redactedReadArgs", "readArgs", "redactedReadResult");
});

test("ordinary and redacted reads remain distinct resources", () => {
  assert.notEqual(readExecutorResource.symbol, redactedReadExecutorResource.symbol);
});
