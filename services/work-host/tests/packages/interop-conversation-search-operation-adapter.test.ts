import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import {
  ConversationSearchArgs,
  ConversationSearchResult,
} from "../../source/adapters/interop/proto/generated/agent/v1/conversation_search_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { conversationSearchExecutorResource } from "../../source/adapters/interop/agent/conversation-search-operation-adapter.ts";

test("conversation search uses its own executor request and result cases", async () => {
  const context = createContext();
  const args = new ConversationSearchArgs();
  const expected = new ConversationSearchResult();
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(101);
      return (async function* () {
        yield new ExecClientMessage({ id: 101, message: { case: "conversationSearchResult", value: expected } });
      })();
    },
  };
  assert.equal(await conversationSearchExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "conversationSearchArgs");
  if (outgoing?.message.case === "conversationSearchArgs") assert.deepEqual(outgoing.message.value, args);

  let handler: ControlledExecHandler | undefined;
  conversationSearchExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 102, message: { case: "adoptArgs", value: {} } as never })), undefined);
  const stream = handler.handle(context, new ExecServerMessage({ id: 103, message: { case: "conversationSearchArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "conversationSearchResult");
  if (replies[0]?.message.case === "conversationSearchResult") assert.deepEqual(replies[0].message.value, expected);
});
