import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { PiEditExecArgs, PiEditExecResult } from "../../source/adapters/interop/proto/generated/agent/v1/pi_edit_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { piEditExecutorResource } from "../../source/adapters/interop/agent/pi-edit-operation-adapter.ts";

test("Pi edit calls use their dedicated executor request and result cases", async () => {
  const context = createContext();
  const args = new PiEditExecArgs();
  const expected = new PiEditExecResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(211);
      return (async function* () {
        yield new ExecClientMessage({ id: 211, message: { case: "piEditResult", value: expected } });
      })();
    },
  };
  assert.equal(await piEditExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "piEditArgs");
  if (outgoing?.message.case === "piEditArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  piEditExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 212, message: { case: "writeArgs", value: {} } as never })), undefined);
  const stream = handler.handle(context, new ExecServerMessage({ id: 213, message: { case: "piEditArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "piEditResult");
  if (replies[0]?.message.case === "piEditResult") assert.deepEqual(replies[0].message.value, expected);
});
