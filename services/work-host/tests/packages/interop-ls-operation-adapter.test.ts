import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import {
  LsArgs,
  LsError,
  LsRejected,
  LsResult,
  LsSuccess,
  LsTimeout,
} from "../../source/adapters/interop/proto/generated/agent/v1/ls_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler, ControlledExecutor } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import {
  lsExecutorArgsFromInterop,
  lsExecutorArgsToInterop,
  lsExecutorResource,
  lsExecutorResultFromInterop,
  lsExecutorResultToInterop,
} from "../../source/adapters/interop/agent/ls-operation-adapter.ts";
import type { LsExecutorArgs, LsExecutorResult, SlateDirectoryTreeNode } from "../../source/packages/agent-exec/ls.ts";
import type { SandboxRule } from "../../source/packages/local-exec/sandbox-policy.ts";

const context = createContext();

const args: LsExecutorArgs = {
  path: "/repo",
  ignore: ["dist/**"],
  toolCallId: "ls-1",
  timeoutMs: 0,
};

const root: SlateDirectoryTreeNode = {
  absPath: "/repo",
  childrenWereProcessed: false,
  childrenFiles: [{
    name: "terminal.txt",
    terminalMetadata: {
      cwd: "/repo",
      lastModifiedMs: 11n,
      lastCommands: [{ command: "build", exitCode: 0, timestampMs: 9n, durationMs: 2n }],
      currentCommand: { command: "watch" },
    },
  }],
  childrenDirs: [{
    absPath: "/repo/src",
    childrenWereProcessed: true,
    childrenFiles: [],
    childrenDirs: [],
    numFiles: 0,
    fullSubtreeExtensionCounts: {},
  }],
  numFiles: 3,
  fullSubtreeExtensionCounts: { ".ts": 3 },
};
const tree: LsExecutorResult = { kind: "success", root };

test("Slate listing arguments and results round-trip through the generated transport boundary", () => {
  const wireArgs = lsExecutorArgsToInterop(args);
  assert.deepEqual(lsExecutorArgsFromInterop(wireArgs), args);

  const wireResult = lsExecutorResultToInterop(tree);
  assert.deepEqual(lsExecutorResultFromInterop(wireResult), tree);

  const timeout = { kind: "timeout", root } satisfies LsExecutorResult;
  assert.deepEqual(lsExecutorResultFromInterop(lsExecutorResultToInterop(timeout)), timeout);
  const noRoot: LsExecutorResult[] = [
    { kind: "success" },
    { kind: "timeout" },
    { kind: "error", path: "/repo/file", error: "read failed" },
    { kind: "rejected", path: "/outside", reason: "outside workspace" },
  ];
  for (const result of noRoot) {
    assert.deepEqual(lsExecutorResultFromInterop(lsExecutorResultToInterop(result)), result);
  }
  assert.deepEqual(lsExecutorResultFromInterop(new LsResult({ result: { case: "success", value: new LsSuccess() } })), { kind: "success" });
  assert.deepEqual(lsExecutorResultFromInterop(new LsResult({ result: { case: "timeout", value: new LsTimeout() } })), { kind: "timeout" });
  assert.deepEqual(lsExecutorResultFromInterop(new LsResult({ result: { case: "error", value: new LsError({ path: "/repo", error: "bad" }) } })), { kind: "error", path: "/repo", error: "bad" });
  assert.deepEqual(lsExecutorResultFromInterop(new LsResult({ result: { case: "rejected", value: new LsRejected({ path: "/outside", reason: "denied" }) } })), { kind: "rejected", path: "/outside", reason: "denied" });
  assert.deepEqual(lsExecutorResultFromInterop(new LsResult()), { kind: "unrecognized" });
});

test("a listing sandbox policy keeps its Slate shape at the application boundary", () => {
  const sandboxPolicy: SandboxRule = {
    type: "workspace_readonly",
    networkPolicy: { version: 1, default: "deny" },
    additionalReadonlyPaths: ["/shared/cache"],
    readBoundary: "workspace",
  };
  const request: LsExecutorArgs = { path: "/repo", sandboxPolicy };
  assert.deepEqual(lsExecutorArgsFromInterop(lsExecutorArgsToInterop(request)), request);
});

test("directory listing uses Slate values on both executor sides and its own transport case", async () => {
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_context, createMessage) {
      outgoing = createMessage(171);
      return (async function* () {
        yield new ExecClientMessage({ id: 171, message: { case: "lsResult", value: lsExecutorResultToInterop(tree) } });
      })();
    },
  };
  assert.deepEqual(await lsExecutorResource.remoteImplementation(remote).execute(context, args), tree);
  assert.equal(outgoing?.message.case, "lsArgs");
  if (outgoing?.message.case === "lsArgs") assert.deepEqual(outgoing.message.value, new LsArgs({
    path: args.path,
    ignore: [...(args.ignore ?? [])],
    ...(args.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }),
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
  }));

  let handler: ControlledExecHandler | undefined;
  let receivedArgs: LsExecutorArgs | undefined;
  const implementation: ControlledExecutor<LsExecutorArgs, LsExecutorResult> = {
    async execute(_ctx, received) {
      receivedArgs = received;
      return tree;
    },
  };
  lsExecutorResource.registerControlledImplementation(implementation, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);

  assert.equal(handler.handle(context, new ExecServerMessage({ id: 172, message: { case: "deleteArgs", value: {} } as never })), undefined);
  const wireRequest = new LsArgs({
    path: args.path,
    ignore: [...(args.ignore ?? [])],
    ...(args.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }),
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
  });
  const stream = handler.handle(context, new ExecServerMessage({ id: 173, message: { case: "lsArgs", value: wireRequest } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.deepEqual(receivedArgs, args);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.message.case, "lsResult");
  if (replies[0]?.message.case === "lsResult") assert.deepEqual(replies[0].message.value, lsExecutorResultToInterop(tree));
});
