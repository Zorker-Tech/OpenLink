import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { GetDiffRequest, GetDiffResponse } from "../../source/adapters/interop/proto/generated/aiserver/v1/utils_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { gitDiffExecutorResource } from "../../source/adapters/interop/agent/git-diff-operation-adapter.ts";

test("git diff requests and responses use their dedicated executor cases", async () => {
  const context = createContext();
  const args = new GetDiffRequest();
  const expected = new GetDiffResponse();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(141);
      return (async function* () {
        yield new ExecClientMessage({ id: 141, message: { case: "gitDiffResponse", value: expected } });
      })();
    },
  };
  assert.equal(await gitDiffExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "gitDiffRequest");
  if (outgoing?.message.case === "gitDiffRequest") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  gitDiffExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 142, message: { case: "fetchArgs", value: {} } as never })), undefined);
  const stream = handler.handle(context, new ExecServerMessage({ id: 143, message: { case: "gitDiffRequest", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "gitDiffResponse");
  if (replies[0]?.message.case === "gitDiffResponse") assert.deepEqual(replies[0].message.value, expected);
});
