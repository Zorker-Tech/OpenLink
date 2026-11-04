import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import {
  McpAllowlistPrecheckArgs,
  McpAllowlistPrecheckResult,
} from "../../source/adapters/interop/proto/generated/agent/v1/mcp_allowlist_precheck_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { mcpAllowlistPrecheckExecutorResource } from "../../source/adapters/interop/agent/mcp-allowlist-precheck-operation-adapter.ts";

test("MCP allowlist prechecks use their dedicated executor cases", async () => {
  const context = createContext();
  const args = new McpAllowlistPrecheckArgs();
  const expected = new McpAllowlistPrecheckResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(181);
      return (async function* () {
        yield new ExecClientMessage({ id: 181, message: { case: "mcpAllowlistPrecheckResult", value: expected } });
      })();
    },
  };
  assert.equal(await mcpAllowlistPrecheckExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "mcpAllowlistPrecheckArgs");
  if (outgoing?.message.case === "mcpAllowlistPrecheckArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  mcpAllowlistPrecheckExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 182, message: { case: "grepArgs", value: {} } as never })), undefined);
  const stream = handler.handle(context, new ExecServerMessage({ id: 183, message: { case: "mcpAllowlistPrecheckArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "mcpAllowlistPrecheckResult");
  if (replies[0]?.message.case === "mcpAllowlistPrecheckResult") assert.deepEqual(replies[0].message.value, expected);
});
