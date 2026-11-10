import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import {
  BackgroundShellSpawnResult,
  BackgroundShellSpawnSuccess,
  WriteShellStdinArgs,
  WriteShellStdinResult,
  WriteShellStdinSuccess,
} from "../../source/adapters/interop/proto/generated/agent/v1/background_shell_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { BackgroundShellSpawnOutcome } from "../../source/packages/local-exec/background-shell-contracts.ts";
import type { ControlledExecHandler, ControlledExecutor } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import {
  backgroundShellExecutorResource,
  backgroundShellSpawnInputFromInterop,
  backgroundShellSpawnInputToInterop,
  backgroundShellSpawnOutcomeFromLocal,
  backgroundShellSpawnResultFromInterop,
  backgroundShellSpawnResultToInterop,
  writeBackgroundShellInputArgsFromInterop,
  writeBackgroundShellInputArgsToInterop,
  writeBackgroundShellInputExecutorResource,
  writeBackgroundShellInputResultFromInterop,
  writeBackgroundShellInputResultToInterop,
} from "../../source/adapters/interop/agent/background-shell-operation-adapter.ts";
import type {
  BackgroundShellExecutorArgs,
  BackgroundShellExecutorResult,
  WriteBackgroundShellInputArgs,
  WriteBackgroundShellInputResult,
} from "../../source/packages/agent-exec/background-shell.ts";

const context = createContext();

const spawnArgs: BackgroundShellExecutorArgs = {
  command: "sleep 2",
  workingDirectory: "/work",
  toolCallId: "call-1",
  enableWriteShellStdinTool: true,
  skipApproval: true,
  adminCommandDenylist: ["rm -rf /"],
};

const spawnSuccess: BackgroundShellExecutorResult = {
  kind: "success",
  shellId: 7,
  command: "sleep 2",
  workingDirectory: "/work",
  pid: 42,
};

test("background shell requests and local outcomes project into Slate's own contract", () => {
  const wireArgs = backgroundShellSpawnInputToInterop(spawnArgs);
  assert.deepEqual(backgroundShellSpawnInputFromInterop(wireArgs), spawnArgs);
  assert.deepEqual(backgroundShellSpawnOutcomeFromLocal({
    kind: "sandbox_unsupported",
    command: "sleep 2",
    workingDirectory: "/work",
    sandboxPolicyType: "workspace_readwrite",
    reason: "unsupported",
    isReadonly: false,
  }), {
    kind: "sandbox-unsupported",
    command: "sleep 2",
    workingDirectory: "/work",
    policyType: "workspace_readwrite",
    reason: "unsupported",
    isReadonly: false,
  });
});

test("spawn outcomes preserve every local state and the transport-specific response case", () => {
  const localOutcomes: BackgroundShellSpawnOutcome[] = [
    { kind: "success", shellId: 7, command: "sleep 2", workingDirectory: "/work", pid: 42 },
    { kind: "rejected", command: "rm -rf /", workingDirectory: "/work", reason: "blocked" },
    { kind: "permission_denied", command: "write", workingDirectory: "/work", error: "denied", isReadonly: true },
    { kind: "sandbox_unsupported", command: "sleep 2", workingDirectory: "/work", sandboxPolicyType: "workspace_readwrite", reason: "unsupported", isReadonly: false },
    { kind: "error", command: "sleep 2", workingDirectory: "/work", error: "spawn failed" },
  ];
  const slateResults = localOutcomes.map(backgroundShellSpawnOutcomeFromLocal);
  for (const result of slateResults) assert.deepEqual(backgroundShellSpawnResultFromInterop(backgroundShellSpawnResultToInterop(result)), result);
  assert.deepEqual(slateResults.map(result => backgroundShellSpawnResultToInterop(result).result.case), [
    "success", "rejected", "permissionDenied", "sandboxUnsupported", "error",
  ]);
  assert.deepEqual(backgroundShellSpawnResultFromInterop(new BackgroundShellSpawnResult()), { kind: "unrecognized" });
});

test("stdin requests and outcomes keep their own shell identity and written length", () => {
  const args: WriteBackgroundShellInputArgs = { shellId: 7, text: "continue\n" };
  assert.deepEqual(writeBackgroundShellInputArgsFromInterop(writeBackgroundShellInputArgsToInterop(args)), args);
  const results: WriteBackgroundShellInputResult[] = [
    { kind: "success", shellId: 7, terminalLengthBeforeWrite: 81 },
    { kind: "error", message: "shell is gone" },
    { kind: "unrecognized" },
  ];
  for (const result of results) assert.deepEqual(writeBackgroundShellInputResultFromInterop(writeBackgroundShellInputResultToInterop(result)), result);
  assert.deepEqual(writeBackgroundShellInputResultFromInterop(new WriteShellStdinResult({ result: { case: "success", value: new WriteShellStdinSuccess({ shellId: 7, terminalFileLengthBeforeInputWritten: 81 }) } })), results[0]);
});

test("spawn and stdin resources exchange Slate values on remote and controlled paths", async () => {
  async function remoteRoundTrip<Args, Result>(options: {
    readonly resource: { remoteImplementation(manager: RemoteExecManager): { execute(ctx: unknown, args: Args): Promise<Result> } };
    readonly args: Args;
    readonly wireArgs: unknown;
    readonly expected: Result;
    readonly wireResult: unknown;
    readonly requestCase: string;
    readonly resultCase: string;
  }): Promise<void> {
    let outgoing: ExecServerMessage | undefined;
    const manager: RemoteExecManager = {
      createExecInstance(_ctx, createMessage) {
        outgoing = createMessage(31);
        return (async function* () {
          yield new ExecClientMessage({ id: 31, message: { case: options.resultCase, value: options.wireResult } as never });
        })();
      },
    };
    assert.deepEqual(await options.resource.remoteImplementation(manager).execute(context, options.args), options.expected);
    assert.equal(outgoing?.message.case, options.requestCase);
    if (outgoing?.message.case === options.requestCase) assert.deepEqual(outgoing.message.value, options.wireArgs);
  }

  const wireSpawnArgs = backgroundShellSpawnInputToInterop(spawnArgs);
  const wireSpawnResult = backgroundShellSpawnResultToInterop(spawnSuccess);
  await remoteRoundTrip({
    resource: backgroundShellExecutorResource,
    args: spawnArgs,
    wireArgs: wireSpawnArgs,
    expected: spawnSuccess,
    wireResult: wireSpawnResult,
    requestCase: "backgroundShellSpawnArgs",
    resultCase: "backgroundShellSpawnResult",
  });

  const stdinArgs: WriteBackgroundShellInputArgs = { shellId: 7, text: "continue\n" };
  const stdinResult: WriteBackgroundShellInputResult = { kind: "success", shellId: 7, terminalLengthBeforeWrite: 81 };
  await remoteRoundTrip({
    resource: writeBackgroundShellInputExecutorResource,
    args: stdinArgs,
    wireArgs: writeBackgroundShellInputArgsToInterop(stdinArgs),
    expected: stdinResult,
    wireResult: writeBackgroundShellInputResultToInterop(stdinResult),
    requestCase: "writeShellStdinArgs",
    resultCase: "writeShellStdinResult",
  });

  async function assertControlledPair<Args, Result>(options: {
    readonly resource: { registerControlledImplementation(implementation: unknown, manager: ControlledExecManager): void };
    readonly args: Args;
    readonly wireArgs: unknown;
    readonly expected: Result;
    readonly wireResult: unknown;
    readonly requestCase: string;
    readonly otherRequestCase: string;
    readonly resultCase: string;
  }): Promise<void> {
    let handler: ControlledExecHandler | undefined;
    const received: unknown[] = [];
    options.resource.registerControlledImplementation({
      async execute(_ctx: unknown, args: unknown) { received.push(args); return options.expected; },
    }, { register(value) { handler = value as ControlledExecHandler; } });
    assert.ok(handler);
    assert.equal(handler.handle(context, new ExecServerMessage({ id: 32, message: { case: options.otherRequestCase, value: options.wireArgs } as never })), undefined);
    const stream = handler.handle(context, new ExecServerMessage({ id: 33, message: { case: options.requestCase, value: options.wireArgs } as never }));
    assert.ok(stream);
    const replies: ExecClientMessage[] = [];
    for await (const reply of stream) replies.push(reply);
    assert.deepEqual(received, [options.args]);
    assert.equal(replies[0]?.message.case, options.resultCase);
    if (replies[0]?.message.case === options.resultCase) assert.deepEqual(replies[0].message.value, options.wireResult);
  }

  await assertControlledPair({
    resource: backgroundShellExecutorResource,
    args: spawnArgs,
    wireArgs: wireSpawnArgs,
    expected: spawnSuccess,
    wireResult: wireSpawnResult,
    requestCase: "backgroundShellSpawnArgs",
    otherRequestCase: "writeShellStdinArgs",
    resultCase: "backgroundShellSpawnResult",
  });
  const stdinArgsWire = writeBackgroundShellInputArgsToInterop(stdinArgs);
  const stdinResultWire = writeBackgroundShellInputResultToInterop(stdinResult);
  await assertControlledPair({
    resource: writeBackgroundShellInputExecutorResource,
    args: stdinArgs,
    wireArgs: stdinArgsWire,
    expected: stdinResult,
    wireResult: stdinResultWire,
    requestCase: "writeShellStdinArgs",
    otherRequestCase: "backgroundShellSpawnArgs",
    resultCase: "writeShellStdinResult",
  });
});
