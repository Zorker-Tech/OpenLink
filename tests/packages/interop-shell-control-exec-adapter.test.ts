import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { ForceBackgroundShellArgs, ForceBackgroundShellResult, ForceBackgroundShellStatus, ShellResult, ShellSuccess } from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ShellControlArgs, ShellControlResult } from "../../source/packages/agent-exec/shell-control.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { forceBackgroundShellExecutorResource } from "../../source/packages/agent-exec/shell-control.ts";

test("background shell control uses its own remote and controlled message cases", async () => {
  const context = createContext();
  const args: ShellControlArgs = { toolCallId: "call-7" };
  const generated = new ForceBackgroundShellResult({
    status: ForceBackgroundShellStatus.ACCEPTED,
    shellResult: new ShellResult({ result: { case: "success", value: new ShellSuccess({
      command: "tail -f output.txt",
      workingDirectory: "/repo",
      exitCode: 0,
      signal: "",
      stdout: "started",
      stderr: "",
      executionTime: 2,
      shellId: 15,
      pid: 20,
      msToWait: 3,
      interleavedOutput: "started",
    }) } }),
  });
  const expected: ShellControlResult = {
    kind: "accepted",
    shellResult: {
      outcome: {
        kind: "success",
        command: "tail -f output.txt",
        workingDirectory: "/repo",
        exitCode: 0,
        signal: "",
        stdout: "started",
        stderr: "",
        executionTimeMs: 2,
        shellId: 15,
        processId: 20,
        waitedMs: 3,
        interleavedOutput: "started",
      },
    },
  };
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(711);
      return (async function* () {
        yield new ExecClientMessage({ id: 711, message: { case: "forceBackgroundShellResult", value: generated } });
      })();
    },
  };

  assert.deepEqual(await forceBackgroundShellExecutorResource.remoteImplementation(remote).execute(context, args), expected);
  assert.equal(outgoing?.message.case, "forceBackgroundShellArgs");
  if (outgoing?.message.case === "forceBackgroundShellArgs") assert.equal(outgoing.message.value.toolCallId, args.toolCallId);

  let handler: ControlledExecHandler | undefined;
  forceBackgroundShellExecutorResource.registerControlledImplementation({ async execute() { return expected; } }, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 712, message: { case: "shellArgs", value: {} } as never })), undefined);

  const stream = handler.handle(context, new ExecServerMessage({ id: 713, message: { case: "forceBackgroundShellArgs", value: new ForceBackgroundShellArgs({ toolCallId: args.toolCallId }) } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "forceBackgroundShellResult");
  if (replies[0]?.message.case === "forceBackgroundShellResult") assert.equal(ForceBackgroundShellResult.equals(replies[0].message.value, generated), true);
});

test("shell-control status maps not-found and retains unknown status codes", async () => {
  const context = createContext();
  const run = async (generated: ForceBackgroundShellResult): Promise<ShellControlResult> => {
    const remote: RemoteExecManager = {
      createExecInstance() {
        return (async function* () {
          yield new ExecClientMessage({ id: 1, message: { case: "forceBackgroundShellResult", value: generated } });
        })();
      },
    };
    return await forceBackgroundShellExecutorResource.remoteImplementation(remote).execute(context, { toolCallId: "call-1" });
  };
  assert.deepEqual(await run(new ForceBackgroundShellResult({ status: ForceBackgroundShellStatus.NOT_FOUND })), { kind: "not-found" });
  assert.deepEqual(await run(new ForceBackgroundShellResult({ status: 81 as ForceBackgroundShellStatus })), { kind: "unrecognized", code: 81 });
});
