import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { DeleteArgs, DeleteResult } from "../../source/adapters/interop/proto/generated/agent/v1/delete_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { deleteExecutorResource } from "../../source/adapters/interop/agent/delete-operation-adapter.ts";

test("deleting a path uses the delete-specific executor cases", async () => {
  const context = createContext();
  const args = new DeleteArgs({ path: "/workspace/old.txt", toolCallId: "delete-1" });
  const expected = new DeleteResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(111);
      return (async function* () {
        yield new ExecClientMessage({ id: 111, message: { case: "deleteResult", value: expected } });
      })();
    },
  };
  assert.equal(await deleteExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "deleteArgs");
  if (outgoing?.message.case === "deleteArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  deleteExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 112, message: { case: "readArgs", value: {} } as never })), undefined);
  const stream = handler.handle(context, new ExecServerMessage({ id: 113, message: { case: "deleteArgs", value: args } }));
  assert.ok(stream);
  const responses: ExecClientMessage[] = [];
  for await (const response of stream) responses.push(response);
  assert.equal(responses.length, 1);
  assert.equal(responses[0]?.message.case, "deleteResult");
  if (responses[0]?.message.case === "deleteResult") assert.deepEqual(responses[0].message.value, expected);
});
