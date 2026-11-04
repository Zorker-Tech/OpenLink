import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { PiFindExecArgs, PiFindExecResult } from "../../source/adapters/interop/proto/generated/agent/v1/pi_find_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { piFindExecutorResource } from "../../source/adapters/interop/agent/pi-find-operation-adapter.ts";

test("Pi find calls use their dedicated executor request and result cases", async () => {
  const context = createContext();
  const args = new PiFindExecArgs();
  const expected = new PiFindExecResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(221);
      return (async function* () {
        yield new ExecClientMessage({ id: 221, message: { case: "piFindResult", value: expected } });
      })();
    },
  };
  assert.equal(await piFindExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "piFindArgs");
  if (outgoing?.message.case === "piFindArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  piFindExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 222, message: { case: "piEditArgs", value: {} } as never })), undefined);
  const stream = handler.handle(context, new ExecServerMessage({ id: 223, message: { case: "piFindArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "piFindResult");
  if (replies[0]?.message.case === "piFindResult") assert.deepEqual(replies[0].message.value, expected);
});
