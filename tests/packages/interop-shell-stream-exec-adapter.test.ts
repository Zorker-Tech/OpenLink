import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { ShellArgs, ShellStream } from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts";
import { createContext, type Context } from "../../source/packages/context/context.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { shellStreamExecutorResource } from "../../source/packages/agent-exec/shell-stream-operation.ts";

const stdout = (data: string) => new ShellStream({ event: { case: "stdout", value: { data } } as never });
const stderr = (data: string) => new ShellStream({ event: { case: "stderr", value: { data } } as never });

test("shell streams preserve matching events and reject other executor cases", async () => {
  const context = createContext();
  const args = new ShellArgs({ command: "print status" });
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

  const events: ShellStream[] = [];
  for await (const event of shellStreamExecutorResource.remoteImplementation(remote).execute(context, args)) events.push(event);
  assert.equal(outgoing?.message.case, "shellStreamArgs");
  if (outgoing?.message.case === "shellStreamArgs") assert.deepEqual(outgoing.message.value, args);
  assert.deepEqual(events.map((event) => event.event.case), ["stdout", "stderr"]);
  assert.equal(events[0], first);
  assert.equal(events[1], second);

  let handler: { handle: (context: Context, message: ExecServerMessage) => AsyncIterable<ExecClientMessage> | undefined } | undefined;
  shellStreamExecutorResource.registerControlledImplementation({
    async *execute() {
      yield first;
      yield second;
    },
  }, {
    register(value) { handler = value as typeof handler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 812, message: { case: "shellArgs", value: {} as never } })), undefined);

  const stream = handler.handle(context, new ExecServerMessage({ id: 813, message: { case: "shellStreamArgs", value: args } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.deepEqual(replies.map((reply) => reply.message.case), ["shellStream", "shellStream"]);
  assert.deepEqual(replies.map((reply) => reply.id), [813, 813]);
});
