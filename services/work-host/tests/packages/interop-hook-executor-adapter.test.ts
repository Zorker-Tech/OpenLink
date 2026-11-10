import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage, ExecuteHookArgs, ExecuteHookResult } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { hookExecutorResource } from "../../source/adapters/interop/agent/hook-executor-adapter.ts";

test("hook execution uses the hook-specific request and response cases", async () => {
  const context = createContext();
  const args = new ExecuteHookArgs();
  const expected = new ExecuteHookResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(161);
      return (async function* () {
        yield new ExecClientMessage({ id: 161, message: { case: "executeHookResult", value: expected } });
      })();
    },
  };
  assert.equal(await hookExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "executeHookArgs");
  if (outgoing?.message.case === "executeHookArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  hookExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 162, message: { case: "deleteArgs", value: {} } as never })), undefined);
  const stream = handler.handle(context, new ExecServerMessage({ id: 163, message: { case: "executeHookArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "executeHookResult");
  if (replies[0]?.message.case === "executeHookResult") assert.deepEqual(replies[0].message.value, expected);
});
