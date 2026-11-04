import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { LsArgs, LsResult } from "../../source/adapters/interop/proto/generated/agent/v1/ls_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { lsExecutorResource } from "../../source/adapters/interop/agent/ls-operation-adapter.ts";

test("directory listing uses its dedicated executor request and result cases", async () => {
  const context = createContext();
  const args = new LsArgs();
  const expected = new LsResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(171);
      return (async function* () {
        yield new ExecClientMessage({ id: 171, message: { case: "lsResult", value: expected } });
      })();
    },
  };
  assert.equal(await lsExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "lsArgs");
  if (outgoing?.message.case === "lsArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  lsExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 172, message: { case: "deleteArgs", value: {} } as never })), undefined);
  const stream = handler.handle(context, new ExecServerMessage({ id: 173, message: { case: "lsArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "lsResult");
  if (replies[0]?.message.case === "lsResult") assert.deepEqual(replies[0].message.value, expected);
});
