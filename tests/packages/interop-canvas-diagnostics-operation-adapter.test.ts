import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { CanvasDiagnosticsArgs, CanvasDiagnosticsResult } from "../../source/adapters/interop/proto/generated/agent/v1/canvas_diagnostics_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { canvasDiagnosticsExecutorResource } from "../../source/adapters/interop/agent/canvas-diagnostics-operation-adapter.ts";

test("canvas diagnostics use their operation-specific request and response cases", async () => {
  const context = createContext();
  const args = new CanvasDiagnosticsArgs({ path: "/workspace/canvas.ts", toolCallId: "call-1" });
  const expected = new CanvasDiagnosticsResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(91);
      return (async function* () {
        yield new ExecClientMessage({ id: 91, message: { case: "canvasDiagnosticsResult", value: expected } });
      })();
    },
  };
  assert.equal(await canvasDiagnosticsExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "canvasDiagnosticsArgs");
  if (outgoing?.message.case === "canvasDiagnosticsArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  canvasDiagnosticsExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 92, message: { case: "writeArgs", value: {} } as never })), undefined);
  const stream = handler.handle(context, new ExecServerMessage({ id: 93, message: { case: "canvasDiagnosticsArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "canvasDiagnosticsResult");
  if (replies[0]?.message.case === "canvasDiagnosticsResult") assert.deepEqual(replies[0].message.value, expected);
});
