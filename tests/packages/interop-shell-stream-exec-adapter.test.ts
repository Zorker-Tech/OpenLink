import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { ShellArgs, ShellStream, TimeoutBehavior } from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts";
import { SandboxPolicy_Type } from "../../source/adapters/interop/proto/generated/agent/v1/sandbox_pb.ts";
import { createContext, type Context } from "../../source/packages/context/context.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { shellStreamExecutorResource } from "../../source/packages/agent-exec/shell-stream-operation.ts";
import type { ShellStreamExecutorArgs, ShellStreamExecutorEvent } from "../../source/packages/agent-exec/shell-stream-operation.ts";

const stdout = (data: string) => new ShellStream({ event: { case: "stdout", value: { data } } as never });
const stderr = (data: string) => new ShellStream({ event: { case: "stderr", value: { data } } as never });

test("shell streams preserve matching events and reject other executor cases", async () => {
  const context = createContext();
  const args: ShellStreamExecutorArgs = {
    command: "print status",
    workingDirectory: "/repo",
    toolCallId: "call-7",
    conversationId: "conversation-9",
    timeout: 250,
    timeoutBehavior: "background",
    hardTimeout: 400,
    closeStdin: true,
    skipApproval: true,
    isBackground: true,
    requestedSandboxPolicy: {
      type: "workspace_readwrite",
      networkPolicy: { version: 1, default: "allow", deny: ["metadata.internal"] },
      additionalReadwritePaths: ["/cache"],
    },
    adminCommandDenylist: ["sudo"],
    smartModeApproval: { reason: "approved", requestId: "approval-2" },
    description: "watch output",
  };
  const first = stdout("ready\n");
  const second = stderr("notice\n");
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(811);
      return (async function* () {
        yield new ExecClientMessage({ id: 811, message: { case: "shellStream", value: first } });
        yield new ExecClientMessage({ id: 811, message: { case: "shellResult", value: {} as never } });
        yield new ExecClientMessage({ id: 811, message: { case: "shellStream", value: second } });
      })();
    },
  };

  const events: ShellStreamExecutorEvent[] = [];
  for await (const event of shellStreamExecutorResource.remoteImplementation(remote).execute(context, args)) events.push(event);
  assert.equal(outgoing?.message.case, "shellStreamArgs");
  if (outgoing?.message.case === "shellStreamArgs") {
    assert.equal(outgoing.message.value.command, args.command);
    assert.equal(outgoing.message.value.workingDirectory, args.workingDirectory);
    assert.equal(outgoing.message.value.toolCallId, args.toolCallId);
    assert.equal(outgoing.message.value.conversationId, args.conversationId);
    assert.equal(outgoing.message.value.timeout, args.timeout);
    assert.equal(outgoing.message.value.timeoutBehavior, TimeoutBehavior.BACKGROUND);
    assert.equal(outgoing.message.value.hardTimeout, args.hardTimeout);
    assert.equal(outgoing.message.value.closeStdin, true);
    assert.equal(outgoing.message.value.skipApproval, true);
    assert.equal(outgoing.message.value.isBackground, true);
    assert.equal(outgoing.message.value.requestedSandboxPolicy?.type, SandboxPolicy_Type.WORKSPACE_READWRITE);
    assert.equal(outgoing.message.value.requestedSandboxPolicy?.networkAccess, true);
    assert.deepEqual(outgoing.message.value.requestedSandboxPolicy?.additionalReadwritePaths, ["/cache"]);
    assert.deepEqual(outgoing.message.value.adminCommandDenylist, ["sudo"]);
    assert.equal(outgoing.message.value.smartModeApproval?.requestId, "approval-2");
    assert.equal(outgoing.message.value.description, "watch output");
  }
  assert.deepEqual(events, [{ type: "stdout", data: "ready\n" }, { type: "stderr", data: "notice\n" }]);

  let handler: { handle: (context: Context, message: ExecServerMessage) => AsyncIterable<ExecClientMessage> | undefined } | undefined;
  shellStreamExecutorResource.registerControlledImplementation({
    async *execute() {
      yield { type: "stdout", data: "ready\n" };
      yield { type: "stderr", data: "notice\n" };
    },
  }, {
    register(value) { handler = value as typeof handler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 812, message: { case: "shellArgs", value: {} as never } })), undefined);

  const stream = handler.handle(context, new ExecServerMessage({ id: 813, message: { case: "shellStreamArgs", value: new ShellArgs({ command: args.command }) } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.deepEqual(replies.map((reply) => reply.message.case), ["shellStream", "shellStream"]);
  assert.deepEqual(replies.map((reply) => reply.id), [813, 813]);
});

test("an omitted timeout policy stays unspecified at the transport edge", async () => {
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(814);
      return (async function* () {})();
    },
  };
  for await (const _event of shellStreamExecutorResource.remoteImplementation(remote).execute(createContext(), { command: "true" })) {}
  assert.equal(outgoing?.message.case, "shellStreamArgs");
  if (outgoing?.message.case === "shellStreamArgs") assert.equal(outgoing.message.value.timeoutBehavior, TimeoutBehavior.UNSPECIFIED);
});
