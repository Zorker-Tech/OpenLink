import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { RequestContextArgs, RequestContextResult } from "../../source/adapters/interop/proto/generated/agent/v1/request_context_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { requestContextExecutorResource } from "../../source/packages/agent-exec/request-context-operation.ts";

test("request-context calls use their own remote and controlled message cases", async () => {
  const context = createContext();
  const args = new RequestContextArgs();
  const expected = new RequestContextResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(511);
      return (async function* () {
        yield new ExecClientMessage({ id: 511, message: { case: "requestContextResult", value: expected } });
      })();
    },
  };

  assert.equal(await requestContextExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "requestContextArgs");
  if (outgoing?.message.case === "requestContextArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  requestContextExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 512, message: { case: "writeArgs", value: {} } as never })), undefined);

  const stream = handler.handle(context, new ExecServerMessage({ id: 513, message: { case: "requestContextArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "requestContextResult");
  if (replies[0]?.message.case === "requestContextResult") assert.deepEqual(replies[0].message.value, expected);
});
