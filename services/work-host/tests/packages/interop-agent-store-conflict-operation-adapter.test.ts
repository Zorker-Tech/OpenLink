import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import {
  AgentStoreConflictArgs,
  AgentStoreConflictResult,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_store_conflict_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { agentStoreConflictExecutorResource } from "../../source/adapters/interop/agent/agent-store-conflict-operation-adapter.ts";

test("agent-store conflict execution uses its own request and result cases", async () => {
  const context = createContext();
  const args = new AgentStoreConflictArgs();
  const expected = new AgentStoreConflictResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(81);
      return (async function* () {
        yield new ExecClientMessage({ id: 81, message: { case: "agentStoreConflictResult", value: expected } });
      })();
    },
  };

  assert.equal(await agentStoreConflictExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "agentStoreConflictArgs");
  if (outgoing?.message.case === "agentStoreConflictArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  agentStoreConflictExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 82, message: { case: "writeArgs", value: {} } as never })), undefined);
  const stream = handler.handle(context, new ExecServerMessage({ id: 83, message: { case: "agentStoreConflictArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "agentStoreConflictResult");
  if (replies[0]?.message.case === "agentStoreConflictResult") assert.deepEqual(replies[0].message.value, expected);
});
