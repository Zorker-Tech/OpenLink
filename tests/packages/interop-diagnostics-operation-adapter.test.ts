import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { DiagnosticsArgs, DiagnosticsResult } from "../../source/adapters/interop/proto/generated/agent/v1/diagnostics_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { diagnosticsExecutorResource } from "../../source/adapters/interop/agent/diagnostics-operation-adapter.ts";

test("diagnostics use their dedicated executor request and result cases", async () => {
  const context = createContext();
  const args = new DiagnosticsArgs();
  const expected = new DiagnosticsResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(121);
      return (async function* () {
        yield new ExecClientMessage({ id: 121, message: { case: "diagnosticsResult", value: expected } });
      })();
    },
  };
  assert.equal(await diagnosticsExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "diagnosticsArgs");
  if (outgoing?.message.case === "diagnosticsArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  diagnosticsExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 122, message: { case: "deleteArgs", value: {} } as never })), undefined);
  const stream = handler.handle(context, new ExecServerMessage({ id: 123, message: { case: "diagnosticsArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "diagnosticsResult");
  if (replies[0]?.message.case === "diagnosticsResult") assert.deepEqual(replies[0].message.value, expected);
});
