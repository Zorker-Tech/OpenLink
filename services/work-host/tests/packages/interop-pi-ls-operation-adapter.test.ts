import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { PiLsExecArgs, PiLsExecResult } from "../../source/adapters/interop/proto/generated/agent/v1/pi_ls_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { piLsExecutorResource } from "../../source/adapters/interop/agent/pi-ls-operation-adapter.ts";

test("Pi ls requests and results use their own executor cases", async () => {
  const context = createContext();
  const args = new PiLsExecArgs();
  const expected = new PiLsExecResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(241);
      return (async function* () {
        yield new ExecClientMessage({ id: 241, message: { case: "piLsResult", value: expected } });
      })();
    },
  };
  assert.equal(await piLsExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "piLsArgs");
  if (outgoing?.message.case === "piLsArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  piLsExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 242, message: { case: "piFindArgs", value: {} } as never })), undefined);
  const stream = handler.handle(context, new ExecServerMessage({ id: 243, message: { case: "piLsArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "piLsResult");
  if (replies[0]?.message.case === "piLsResult") assert.deepEqual(replies[0].message.value, expected);
});
