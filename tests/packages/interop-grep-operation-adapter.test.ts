import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { GrepArgs, GrepResult } from "../../source/adapters/interop/proto/generated/agent/v1/grep_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { grepExecutorResource } from "../../source/adapters/interop/agent/grep-operation-adapter.ts";

test("grep uses its dedicated executor request and result cases", async () => {
  const context = createContext();
  const args = new GrepArgs();
  const expected = new GrepResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(151);
      return (async function* () {
        yield new ExecClientMessage({ id: 151, message: { case: "grepResult", value: expected } });
      })();
    },
  };
  assert.equal(await grepExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "grepArgs");
  if (outgoing?.message.case === "grepArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  grepExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 152, message: { case: "deleteArgs", value: {} } as never })), undefined);
  const stream = handler.handle(context, new ExecServerMessage({ id: 153, message: { case: "grepArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "grepResult");
  if (replies[0]?.message.case === "grepResult") assert.deepEqual(replies[0].message.value, expected);
});
