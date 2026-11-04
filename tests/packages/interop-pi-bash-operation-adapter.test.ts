import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { PiBashExecArgs, PiBashExecResult } from "../../source/adapters/interop/proto/generated/agent/v1/pi_bash_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { piBashExecutorResource } from "../../source/adapters/interop/agent/pi-bash-operation-adapter.ts";

test("Pi Bash calls use their dedicated executor cases", async () => {
  const context = createContext();
  const args = new PiBashExecArgs();
  const expected = new PiBashExecResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(201);
      return (async function* () {
        yield new ExecClientMessage({ id: 201, message: { case: "piBashResult", value: expected } });
      })();
    },
  };
  assert.equal(await piBashExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "piBashArgs");
  if (outgoing?.message.case === "piBashArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  piBashExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 202, message: { case: "shellArgs", value: {} } as never })), undefined);
  const stream = handler.handle(context, new ExecServerMessage({ id: 203, message: { case: "piBashArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "piBashResult");
  if (replies[0]?.message.case === "piBashResult") assert.deepEqual(replies[0].message.value, expected);
});
