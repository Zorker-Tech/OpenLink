import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import {
  BackgroundShellSpawnArgs,
  BackgroundShellSpawnResult,
  WriteShellStdinArgs,
  WriteShellStdinResult,
} from "../../source/adapters/interop/proto/generated/agent/v1/background_shell_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import { backgroundShellSpawnInputFromInterop, backgroundShellSpawnOutcomeToInterop } from "../../source/adapters/interop/agent/background-shell-operation-adapter.ts";
import type { ControlledExecHandler } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import {
  backgroundShellExecutorResource,
  writeBackgroundShellInputExecutorResource,
} from "../../source/adapters/interop/agent/background-shell-operation-adapter.ts";

const context = createContext();

test("background shell messages project to and from Slate's spawn contract", () => {
  const input = backgroundShellSpawnInputFromInterop(new BackgroundShellSpawnArgs({
    command: "sleep 2",
    workingDirectory: "/work",
    toolCallId: "call-1",
    enableWriteShellStdinTool: true,
    skipApproval: true,
    adminCommandDenylist: ["rm -rf /"],
  }));
  assert.deepEqual(input, {
    command: "sleep 2",
    workingDirectory: "/work",
    toolCallId: "call-1",
    enableWriteShellStdinTool: true,
    skipApproval: true,
    adminCommandDenylist: ["rm -rf /"],
  });

  const outcomes = [
    { kind: "success", shellId: 7, command: "sleep 2", workingDirectory: "/work", pid: 42 },
    { kind: "rejected", command: "rm -rf /", workingDirectory: "/work", reason: "blocked" },
    { kind: "permission_denied", command: "write", workingDirectory: "/work", error: "denied", isReadonly: true },
    { kind: "sandbox_unsupported", command: "sleep 2", workingDirectory: "/work", sandboxPolicyType: "workspace_readwrite", reason: "unsupported", isReadonly: false },
    { kind: "error", command: "sleep 2", workingDirectory: "/work", error: "spawn failed" },
  ] as const;
  const results = outcomes.map(backgroundShellSpawnOutcomeToInterop);
  assert.ok(results.every((result) => result instanceof BackgroundShellSpawnResult));
  assert.deepEqual(results.map((result) => result.result.case), ["success", "rejected", "permissionDenied", "sandboxUnsupported", "error"]);
  assert.deepEqual(results.map((result) => result.result.value?.toJson()), [
    { shellId: 7, command: "sleep 2", workingDirectory: "/work", pid: 42 },
    { command: "rm -rf /", workingDirectory: "/work", reason: "blocked" },
    { command: "write", workingDirectory: "/work", error: "denied", isReadonly: true },
    { command: "sleep 2", workingDirectory: "/work", sandboxPolicyType: "workspace_readwrite", reason: "unsupported" },
    { command: "sleep 2", workingDirectory: "/work", error: "spawn failed" },
  ]);
  assert.equal((results[3]?.result.value as { isReadonly: boolean }).isReadonly, false);
});

async function roundTripRemote(
  resource: { remoteImplementation(manager: RemoteExecManager): { execute(context: unknown, args: unknown): Promise<unknown> } },
  args: unknown,
  response: unknown,
  requestCase: string,
  responseCase: string,
): Promise<void> {
  let outgoing: ExecServerMessage | undefined;
  const manager: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(31);
      return (async function* () {
        yield new ExecClientMessage({ id: 31, message: { case: responseCase, value: response } as never });
      })();
    },
  };

  assert.equal(await resource.remoteImplementation(manager).execute(context, args), response);
  assert.equal(outgoing?.message.case, requestCase);
  if (outgoing?.message.case === requestCase) assert.deepEqual(outgoing.message.value, args);
}

async function assertControlledPair(options: {
  readonly register: (implementation: unknown, manager: ControlledExecManager) => void;
  readonly args: unknown;
  readonly response: unknown;
  readonly requestCase: string;
  readonly responseCase: string;
  readonly otherRequestCase: string;
}): Promise<void> {
  let handler: ControlledExecHandler | undefined;
  const received: unknown[] = [];
  options.register({
    async execute(_context: unknown, args: unknown) {
      received.push(args);
      return options.response;
    },
  }, { register: (value) => { handler = value as ControlledExecHandler; } });
  assert.ok(handler);

  const other = new ExecServerMessage({
    id: 32,
    message: { case: options.otherRequestCase, value: options.args } as never,
  });
  assert.equal(handler.handle(context, other), undefined);

  const request = new ExecServerMessage({
    id: 33,
    message: { case: options.requestCase, value: options.args } as never,
  });
  const stream = handler.handle(context, request);
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.deepEqual(received, [options.args]);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, options.responseCase);
  if (replies[0]?.message.case === options.responseCase) {
    assert.deepEqual(replies[0].message.value, options.response);
  }
}

test("starting and writing to a background shell use separate protocol cases", async () => {
  const spawnArgs = new BackgroundShellSpawnArgs({ command: "sleep 1" });
  const spawnResult = new BackgroundShellSpawnResult();
  const writeArgs = new WriteShellStdinArgs({ shellId: 7, chars: "continue\n" });
  const writeResult = new WriteShellStdinResult();

  assert.notEqual(backgroundShellExecutorResource.symbol, writeBackgroundShellInputExecutorResource.symbol);
  await roundTripRemote(backgroundShellExecutorResource, spawnArgs, spawnResult, "backgroundShellSpawnArgs", "backgroundShellSpawnResult");
  await roundTripRemote(writeBackgroundShellInputExecutorResource, writeArgs, writeResult, "writeShellStdinArgs", "writeShellStdinResult");
  await assertControlledPair({
    register: (implementation, manager) => backgroundShellExecutorResource.registerControlledImplementation(implementation as never, manager),
    args: spawnArgs,
    response: spawnResult,
    requestCase: "backgroundShellSpawnArgs",
    responseCase: "backgroundShellSpawnResult",
    otherRequestCase: "writeShellStdinArgs",
  });
  await assertControlledPair({
    register: (implementation, manager) => writeBackgroundShellInputExecutorResource.registerControlledImplementation(implementation as never, manager),
    args: writeArgs,
    response: writeResult,
    requestCase: "writeShellStdinArgs",
    responseCase: "writeShellStdinResult",
    otherRequestCase: "backgroundShellSpawnArgs",
  });
});
