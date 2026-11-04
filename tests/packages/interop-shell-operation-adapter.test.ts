import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { ShellArgs, ShellResult } from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { shellExecutorResource } from "../../source/adapters/interop/agent/shell-operation-adapter.ts";

const context = createContext();

test("shell execution uses only the shell request and result cases", async () => {
  const args = new ShellArgs();
  const expected = new ShellResult();
  let outgoing: ExecServerMessage | undefined;
  const remoteManager: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(51);
      return (async function* () {
        yield new ExecClientMessage({ id: 51, message: { case: "shellResult", value: expected } });
      })();
    },
  };
  const remote = shellExecutorResource.remoteImplementation(remoteManager);

  assert.equal(await remote.execute(context, args), expected);
  assert.equal(outgoing?.message.case, "shellArgs");
  if (outgoing?.message.case === "shellArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  const manager: ControlledExecManager = {
    register(value) { handler = value as ControlledExecHandler; },
  };
  shellExecutorResource.registerControlledImplementation({
    async execute() { return expected; },
  }, manager);
  assert.ok(handler);

  const otherOperation = new ExecServerMessage({
    id: 52,
    message: { case: "backgroundShellSpawnArgs", value: {} } as never,
  });
  assert.equal(handler.handle(context, otherOperation), undefined);

  const request = new ExecServerMessage({ id: 53, message: { case: "shellArgs", value: args } });
  const stream = handler.handle(context, request);
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "shellResult");
  if (replies[0]?.message.case === "shellResult") assert.deepEqual(replies[0].message.value, expected);
});
