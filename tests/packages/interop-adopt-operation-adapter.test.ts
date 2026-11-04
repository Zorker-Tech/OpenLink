import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { AdoptArgs, AdoptResult } from "../../source/adapters/interop/proto/generated/agent/v1/adopt_tool_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { adoptExecutorResource } from "../../source/adapters/interop/agent/adopt-operation-adapter.ts";

test("adopt requests and responses use their own executor case", async () => {
  const context = createContext();
  const args = new AdoptArgs();
  const expected = new AdoptResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(71);
      return (async function* () {
        yield new ExecClientMessage({ id: 71, message: { case: "adoptResult", value: expected } });
      })();
    },
  };

  assert.equal(await adoptExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "adoptArgs");
  if (outgoing?.message.case === "adoptArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  adoptExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 72, message: { case: "writeArgs", value: {} } as never })), undefined);
  const stream = handler.handle(context, new ExecServerMessage({ id: 73, message: { case: "adoptArgs", value: args } }));
  assert.ok(stream);
  const responses: ExecClientMessage[] = [];
  for await (const response of stream) responses.push(response);
  assert.equal(responses.length, 1);
  assert.equal(responses[0]?.message.case, "adoptResult");
  if (responses[0]?.message.case === "adoptResult") assert.deepEqual(responses[0].message.value, expected);
});
