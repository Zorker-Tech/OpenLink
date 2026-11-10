import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { WebFetchAllowlistPrecheckArgs, WebFetchAllowlistPrecheckResult } from "../../source/adapters/interop/proto/generated/agent/v1/web_fetch_allowlist_precheck_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { webFetchAllowlistPrecheckExecutorResource } from "../../source/packages/agent-exec/web-fetch-allowlist-precheck.ts";

test("web-fetch prechecks keep their request and result cases paired", async () => {
  const context = createContext();
  const args = new WebFetchAllowlistPrecheckArgs();
  const expected = new WebFetchAllowlistPrecheckResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(1111);
      return (async function* () {
        yield new ExecClientMessage({ id: 1111, message: { case: "webFetchAllowlistPrecheckResult", value: expected } });
      })();
    },
  };

  assert.equal(await webFetchAllowlistPrecheckExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "webFetchAllowlistPrecheckArgs");
  if (outgoing?.message.case === "webFetchAllowlistPrecheckArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  webFetchAllowlistPrecheckExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 1112, message: { case: "fetchArgs", value: {} } as never })), undefined);

  const stream = handler.handle(context, new ExecServerMessage({ id: 1113, message: { case: "webFetchAllowlistPrecheckArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "webFetchAllowlistPrecheckResult");
  if (replies[0]?.message.case === "webFetchAllowlistPrecheckResult") assert.deepEqual(replies[0].message.value, expected);
});
