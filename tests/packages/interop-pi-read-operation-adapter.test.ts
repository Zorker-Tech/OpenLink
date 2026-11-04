import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { PiReadExecArgs, PiReadExecResult } from "../../source/adapters/interop/proto/generated/agent/v1/pi_read_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { piReadExecutorResource } from "../../source/adapters/interop/agent/pi-read-operation-adapter.ts";

test("Pi read requests and results use dedicated executor cases", async () => {
  const context = createContext();
  const args = new PiReadExecArgs();
  const expected = new PiReadExecResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(251);
      return (async function* () {
        yield new ExecClientMessage({ id: 251, message: { case: "piReadResult", value: expected } });
      })();
    },
  };
  assert.equal(await piReadExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "piReadArgs");
  if (outgoing?.message.case === "piReadArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  piReadExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 252, message: { case: "piLsArgs", value: {} } as never })), undefined);
  const stream = handler.handle(context, new ExecServerMessage({ id: 253, message: { case: "piReadArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "piReadResult");
  if (replies[0]?.message.case === "piReadResult") assert.deepEqual(replies[0].message.value, expected);
});
