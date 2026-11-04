import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { SubagentAwaitArgs, SubagentAwaitResult } from "../../source/adapters/interop/proto/generated/agent/v1/subagent_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { subagentAwaitExecutorResource } from "../../source/packages/agent-exec/subagent-await.ts";

test("subagent-await calls keep their request and result cases paired", async () => {
  const context = createContext();
  const args = new SubagentAwaitArgs();
  const expected = new SubagentAwaitResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(911);
      return (async function* () {
        yield new ExecClientMessage({ id: 911, message: { case: "subagentAwaitResult", value: expected } });
      })();
    },
  };

  assert.equal(await subagentAwaitExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "subagentAwaitArgs");
  if (outgoing?.message.case === "subagentAwaitArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  subagentAwaitExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 912, message: { case: "subagentArgs", value: {} } as never })), undefined);

  const stream = handler.handle(context, new ExecServerMessage({ id: 913, message: { case: "subagentAwaitArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "subagentAwaitResult");
  if (replies[0]?.message.case === "subagentAwaitResult") assert.deepEqual(replies[0].message.value, expected);
});
