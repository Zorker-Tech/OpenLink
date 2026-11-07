import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { ShellAbortReason, ShellArgs, ShellBackgroundReason, ShellFailure, ShellPermissionDenied, ShellRejected, ShellResult, ShellSpawnError, ShellSuccess, ShellTimeout } from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts";
import { OutputLocation } from "../../source/adapters/interop/proto/generated/agent/v1/utils_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ShellExecResponse, ShellExecutorArgs } from "../../source/packages/agent-exec/shell.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import { shellExecutorResource } from "../../source/adapters/interop/agent/shell-operation-adapter.ts";

const context = createContext();

test("shell execution uses only the shell request and result cases", async () => {
  const args: ShellExecutorArgs = {
    command: "git status",
    workingDirectory: "/repo",
    toolCallId: "call-1",
    fileOutputThresholdBytes: 9_007_199_254_740_993n,
    simpleCommands: ["git"],
    hasInputRedirect: false,
    hasOutputRedirect: false,
    parsing: {
      failed: false,
      executableCommands: [{ name: "git", fullText: "git status", arguments: [{ type: "word", value: "status" }] }],
      hasRedirects: false,
      hasCommandSubstitution: false,
      redirects: [],
    },
    skipApproval: true,
  };
  const generated = new ShellResult({ result: { case: "success", value: { command: "git status", workingDirectory: "/repo", exitCode: 0, stdout: "clean", stderr: "", signal: "", executionTime: 3 } } });
  const expected: ShellExecResponse = {
    outcome: { kind: "success", command: "git status", workingDirectory: "/repo", exitCode: 0, stdout: "clean", stderr: "", signal: "", executionTimeMs: 3 },
  };
  let outgoing: ExecServerMessage | undefined;
  const remoteManager: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(51);
      return (async function* () {
        yield new ExecClientMessage({ id: 51, message: { case: "shellResult", value: generated } });
      })();
    },
  };
  const remote = shellExecutorResource.remoteImplementation(remoteManager);

  assert.deepEqual(await remote.execute(context, args), expected);
  assert.equal(outgoing?.message.case, "shellArgs");
  if (outgoing?.message.case === "shellArgs") {
    assert.equal(outgoing.message.value.command, args.command);
    assert.equal(outgoing.message.value.workingDirectory, args.workingDirectory);
    assert.equal(outgoing.message.value.skipApproval, true);
    assert.equal(outgoing.message.value.fileOutputThresholdBytes, 9_007_199_254_740_993n);
    assert.equal(outgoing.message.value.parsingResult?.executableCommands[0]?.name, "git");
  }

  let handler: ControlledExecHandler | undefined;
  const manager: ControlledExecManager = {
    register(value) { handler = value as ControlledExecHandler; },
  };
  shellExecutorResource.registerControlledImplementation({
    async execute() { return expected; },
  }, manager);
  assert.ok(handler);

  const otherOperation = new ExecServerMessage({
    id: 52,
    message: { case: "backgroundShellSpawnArgs", value: {} } as never,
  });
  assert.equal(handler.handle(context, otherOperation), undefined);

  assert.equal(outgoing?.message.case, "shellArgs");
  const requestArgs = outgoing?.message.case === "shellArgs" ? outgoing.message.value : new ShellArgs();
  const request = new ExecServerMessage({ id: 53, message: { case: "shellArgs", value: requestArgs } });
  const stream = handler.handle(context, request);
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "shellResult");
  if (replies[0]?.message.case === "shellResult") assert.deepEqual(replies[0].message.value, generated);
});

test("every shell outcome round-trips through Slate without dropping result metadata", async () => {
  const args: ShellExecutorArgs = { command: "true" };
  const generatedResults = [
    new ShellResult({
      isBackground: true,
      terminalsFolder: "terminals",
      pid: 900,
      result: { case: "success", value: new ShellSuccess({
        command: "tail -f output.txt",
        workingDirectory: "/repo",
        exitCode: 0,
        signal: "",
        stdout: "head",
        stderr: "",
        executionTime: 7,
        outputLocation: new OutputLocation({ filePath: "/repo/output.txt", sizeBytes: 24n, lineCount: 3n }),
        shellId: 44,
        interleavedOutput: "head",
        pid: 81,
        msToWait: 3,
        localExecutionTimeMs: 7,
        backgroundReason: 73 as ShellBackgroundReason,
        outputHead: "head",
        outputTail: "tail",
        elidedChars: 5,
      }) },
    }),
    new ShellResult({ result: { case: "failure", value: new ShellFailure({
      command: "sleep 5",
      workingDirectory: "/repo",
      exitCode: 143,
      signal: "SIGTERM",
      stdout: "partial",
      stderr: "stopped",
      executionTime: 8,
      outputLocation: new OutputLocation({ filePath: "/repo/partial.txt", sizeBytes: 8n, lineCount: 1n }),
      interleavedOutput: "partialstopped",
      abortReason: 91 as ShellAbortReason,
      aborted: true,
      localExecutionTimeMs: 8,
      outputHead: "partial",
      outputTail: "stopped",
      elidedChars: 9,
    }) } }),
    new ShellResult({ result: { case: "timeout", value: new ShellTimeout({ command: "sleep 8", workingDirectory: "/repo", timeoutMs: 80 }) } }),
    new ShellResult({ result: { case: "rejected", value: new ShellRejected({ command: "rm -rf /", workingDirectory: "/repo", reason: "blocked", isReadonly: true }) } }),
    new ShellResult({ result: { case: "spawnError", value: new ShellSpawnError({ command: "missing", workingDirectory: "/repo", error: "ENOENT" }) } }),
    new ShellResult({ result: { case: "permissionDenied", value: new ShellPermissionDenied({ command: "touch x", workingDirectory: "/repo", error: "read only", isReadonly: true }) } }),
    new ShellResult(),
  ];
  const expectedKinds = ["success", "failure", "timeout", "rejected", "spawn-error", "permission-denied", "unrecognized"];

  for (const [index, generated] of generatedResults.entries()) {
    let response: ShellExecResponse | undefined;
    const remote: RemoteExecManager = {
      createExecInstance(_ctx, createMessage) {
        const request = createMessage(70 + index);
        assert.equal(request.message.case, "shellArgs");
        return (async function* () {
          yield new ExecClientMessage({ id: 70 + index, message: { case: "shellResult", value: generated } });
        })();
      },
    };
    response = await shellExecutorResource.remoteImplementation(remote).execute(context, args);
    assert.equal(response.outcome.kind, expectedKinds[index]);

    let handler: ControlledExecHandler | undefined;
    const controlledManager: ControlledExecManager = { register(value) { handler = value as ControlledExecHandler; } };
    shellExecutorResource.registerControlledImplementation({
      async execute(): Promise<ShellExecResponse> { return response!; },
    }, controlledManager);
    assert.ok(handler);
    const call = handler.handle(context, new ExecServerMessage({ id: 90 + index, message: { case: "shellArgs", value: new ShellArgs({ command: args.command }) } }));
    assert.ok(call);
    const replies: ExecClientMessage[] = [];
    for await (const reply of call) replies.push(reply);
    assert.equal(replies[0]?.message.case, "shellResult");
    if (replies[0]?.message.case === "shellResult") assert.equal(ShellResult.equals(replies[0].message.value, generated), true);
  }
});
