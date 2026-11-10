import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { RecordScreenArgs, RecordScreenResult } from "../../source/adapters/interop/proto/generated/agent/v1/record_screen_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { recordScreenExecutorResource } from "../../source/packages/agent-exec/record-screen.ts";

test("screen-recording calls use their own remote and controlled message cases", async () => {
  const context = createContext();
  const args = new RecordScreenArgs();
  const expected = new RecordScreenResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(411);
      return (async function* () {
        yield new ExecClientMessage({ id: 411, message: { case: "recordScreenResult", value: expected } });
      })();
    },
  };

  assert.equal(await recordScreenExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "recordScreenArgs");
  if (outgoing?.message.case === "recordScreenArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  recordScreenExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 412, message: { case: "writeArgs", value: {} } as never })), undefined);

  const stream = handler.handle(context, new ExecServerMessage({ id: 413, message: { case: "recordScreenArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "recordScreenResult");
  if (replies[0]?.message.case === "recordScreenResult") assert.deepEqual(replies[0].message.value, expected);
});
