import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { ForceBackgroundShellArgs, ForceBackgroundShellResult } from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { forceBackgroundShellExecutorResource } from "../../source/packages/agent-exec/shell-control.ts";

test("background shell control uses its own remote and controlled message cases", async () => {
  const context = createContext();
  const args = new ForceBackgroundShellArgs();
  const expected = new ForceBackgroundShellResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(711);
      return (async function* () {
        yield new ExecClientMessage({ id: 711, message: { case: "forceBackgroundShellResult", value: expected } });
      })();
    },
  };

  assert.equal(await forceBackgroundShellExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "forceBackgroundShellArgs");
  if (outgoing?.message.case === "forceBackgroundShellArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  forceBackgroundShellExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 712, message: { case: "shellArgs", value: {} } as never })), undefined);

  const stream = handler.handle(context, new ExecServerMessage({ id: 713, message: { case: "forceBackgroundShellArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "forceBackgroundShellResult");
  if (replies[0]?.message.case === "forceBackgroundShellResult") assert.deepEqual(replies[0].message.value, expected);
});
