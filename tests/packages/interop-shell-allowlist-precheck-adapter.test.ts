import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { ShellAllowlistPrecheckArgs, ShellAllowlistPrecheckResult } from "../../source/adapters/interop/proto/generated/agent/v1/shell_allowlist_precheck_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { shellAllowlistPrecheckExecutorResource } from "../../source/packages/agent-exec/shell-allowlist-precheck.ts";

test("shell allowlist prechecks keep their request and result cases paired", async () => {
  const context = createContext();
  const args = new ShellAllowlistPrecheckArgs();
  const expected = new ShellAllowlistPrecheckResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(611);
      return (async function* () {
        yield new ExecClientMessage({ id: 611, message: { case: "shellAllowlistPrecheckResult", value: expected } });
      })();
    },
  };

  assert.equal(await shellAllowlistPrecheckExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "shellAllowlistPrecheckArgs");
  if (outgoing?.message.case === "shellAllowlistPrecheckArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  shellAllowlistPrecheckExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 612, message: { case: "shellArgs", value: {} } as never })), undefined);

  const stream = handler.handle(context, new ExecServerMessage({ id: 613, message: { case: "shellAllowlistPrecheckArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "shellAllowlistPrecheckResult");
  if (replies[0]?.message.case === "shellAllowlistPrecheckResult") assert.deepEqual(replies[0].message.value, expected);
});
