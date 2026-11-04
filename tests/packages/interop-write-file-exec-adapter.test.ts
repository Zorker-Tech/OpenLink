import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { PiWriteExecArgs, PiWriteExecResult } from "../../source/adapters/interop/proto/generated/agent/v1/pi_write_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { agentFileWriteExecutorResource } from "../../source/packages/agent-exec/agent-file-write.ts";

test("file-write calls use their dedicated remote and controlled message cases", async () => {
  const context = createContext();
  const args = new PiWriteExecArgs();
  const expected = new PiWriteExecResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(311);
      return (async function* () {
        yield new ExecClientMessage({ id: 311, message: { case: "piWriteResult", value: expected } });
      })();
    },
  };

  assert.equal(await agentFileWriteExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "piWriteArgs");
  if (outgoing?.message.case === "piWriteArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  agentFileWriteExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 312, message: { case: "readArgs", value: {} } as never })), undefined);

  const stream = handler.handle(context, new ExecServerMessage({ id: 313, message: { case: "piWriteArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "piWriteResult");
  if (replies[0]?.message.case === "piWriteResult") assert.deepEqual(replies[0].message.value, expected);
});
