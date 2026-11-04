import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { FetchArgs, FetchResult } from "../../source/adapters/interop/proto/generated/agent/v1/fetch_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { fetchExecutorResource } from "../../source/adapters/interop/agent/fetch-operation-adapter.ts";

test("fetch operations use their own executor request and result cases", async () => {
  const context = createContext();
  const args = new FetchArgs();
  const expected = new FetchResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(131);
      return (async function* () {
        yield new ExecClientMessage({ id: 131, message: { case: "fetchResult", value: expected } });
      })();
    },
  };
  assert.equal(await fetchExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "fetchArgs");
  if (outgoing?.message.case === "fetchArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  fetchExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 132, message: { case: "diagnosticsArgs", value: {} } as never })), undefined);
  const stream = handler.handle(context, new ExecServerMessage({ id: 133, message: { case: "fetchArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "fetchResult");
  if (replies[0]?.message.case === "fetchResult") assert.deepEqual(replies[0].message.value, expected);
});
