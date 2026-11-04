import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { ShellArgs, ShellResult } from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { miniSweAgentBashExecutorResource } from "../../source/adapters/interop/agent/mini-swe-bash-operation-adapter.ts";

test("the delegated Bash operation uses its own executor request and result cases", async () => {
  const context = createContext();
  const args = new ShellArgs();
  const expected = new ShellResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(191);
      return (async function* () {
        yield new ExecClientMessage({ id: 191, message: { case: "miniSweAgentBashResult", value: expected } });
      })();
    },
  };
  assert.equal(await miniSweAgentBashExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "miniSweAgentBashArgs");
  if (outgoing?.message.case === "miniSweAgentBashArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  miniSweAgentBashExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 192, message: { case: "shellArgs", value: args } })), undefined);
  const stream = handler.handle(context, new ExecServerMessage({ id: 193, message: { case: "miniSweAgentBashArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "miniSweAgentBashResult");
  if (replies[0]?.message.case === "miniSweAgentBashResult") assert.deepEqual(replies[0].message.value, expected);
});
