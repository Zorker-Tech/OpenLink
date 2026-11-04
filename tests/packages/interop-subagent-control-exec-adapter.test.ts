import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { ForceBackgroundSubagentArgs, ForceBackgroundSubagentResult } from "../../source/adapters/interop/proto/generated/agent/v1/subagent_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { forceBackgroundSubagentExecutorResource } from "../../source/packages/agent-exec/subagent-control.ts";

test("subagent control uses its own remote and controlled message cases", async () => {
  const context = createContext();
  const args = new ForceBackgroundSubagentArgs();
  const expected = new ForceBackgroundSubagentResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(1011);
      return (async function* () {
        yield new ExecClientMessage({ id: 1011, message: { case: "forceBackgroundSubagentResult", value: expected } });
      })();
    },
  };

  assert.equal(await forceBackgroundSubagentExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "forceBackgroundSubagentArgs");
  if (outgoing?.message.case === "forceBackgroundSubagentArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  forceBackgroundSubagentExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 1012, message: { case: "subagentAwaitArgs", value: {} } as never })), undefined);

  const stream = handler.handle(context, new ExecServerMessage({ id: 1013, message: { case: "forceBackgroundSubagentArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "forceBackgroundSubagentResult");
  if (replies[0]?.message.case === "forceBackgroundSubagentResult") assert.deepEqual(replies[0].message.value, expected);
});
