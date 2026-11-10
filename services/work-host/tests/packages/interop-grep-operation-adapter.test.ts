import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import {
  GrepArgs,
  GrepContentMatch,
  GrepContentResult,
  GrepError,
  GrepFileCount,
  GrepFileMatch,
  GrepFilesResult,
  GrepResult,
  GrepSuccess,
  GrepUnionResult,
} from "../../source/adapters/interop/proto/generated/agent/v1/grep_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ControlledExecHandler, ControlledExecutor } from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts";
import type { ControlledExecManager } from "../../source/packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts";
import {
  grepExecutorArgsFromInterop,
  grepExecutorArgsToInterop,
  grepExecutorResource,
  grepExecutorResultFromInterop,
  grepExecutorResultToInterop,
  grepOutputResultFromInterop,
  grepOutputResultToInterop,
} from "../../source/adapters/interop/agent/grep-operation-adapter.ts";
import type { GrepExecutorArgs, GrepExecutorResult, GrepOutputResult } from "../../source/packages/agent-exec/grep.ts";

const context = createContext();

const args: GrepExecutorArgs = {
  query: "needle",
  path: "/repo",
  filePattern: "*.ts",
  mode: "content",
  contextBefore: 1,
  contextAfter: 2,
  contextLines: 3,
  ignoreCase: true,
  fileType: "typescript",
  resultLimit: 0,
  multiline: false,
  sortBy: "path",
  ascending: false,
  toolCallId: "grep-1",
  sandboxPolicy: { type: "workspace_readonly" },
  offset: 0,
};

const outputResults: GrepOutputResult[] = [
  {
    kind: "count",
    files: [{ path: "/repo/a.ts", matches: 2 }],
    totalFiles: 1,
    totalMatches: 2,
    resultTruncated: true,
    searchTruncated: false,
    resultLimitApplied: 10,
    offsetApplied: 4,
  },
  {
    kind: "files",
    files: ["/repo/a.ts"],
    totalFiles: 1,
    resultTruncated: false,
    searchTruncated: true,
    resultLimitApplied: 8,
  },
  {
    kind: "content",
    files: [{ path: "/repo/a.ts", lines: [{ lineNumber: 5, content: "needle", contentTruncated: false, isContextLine: false }] }],
    totalLines: 1,
    totalMatchedLines: 1,
    resultTruncated: false,
    searchTruncated: false,
    offsetApplied: 0,
  },
  { kind: "unrecognized" },
];

const success: GrepExecutorResult = {
  kind: "success",
  query: "needle",
  rootPath: "/repo",
  mode: "content",
  workspaceResults: { "/repo": outputResults[2]! },
  activeEditorResult: outputResults[0]!,
};

test("Slate grep arguments preserve filtering, ordering, pagination and sandbox policy", () => {
  const roundTripped = grepExecutorArgsFromInterop(grepExecutorArgsToInterop(args));
  const stripSandboxPolicy = (value: GrepExecutorArgs) => Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "sandboxPolicy"),
  );
  assert.deepEqual(stripSandboxPolicy(roundTripped), stripSandboxPolicy(args));
  assert.equal(roundTripped.sandboxPolicy?.type, "workspace_readonly");
  assert.equal(roundTripped.sandboxPolicy?.networkPolicy?.default, "deny");
  assert.deepEqual(grepExecutorArgsFromInterop(new GrepArgs({ pattern: "x" })), { query: "x" });
});

test("count, file and content result unions preserve all summaries and truncation metadata", () => {
  for (const result of outputResults) assert.deepEqual(grepOutputResultFromInterop(grepOutputResultToInterop(result)), result);
  assert.deepEqual(grepExecutorResultFromInterop(grepExecutorResultToInterop(success)), success);
  assert.deepEqual(grepExecutorResultFromInterop(grepExecutorResultToInterop({ kind: "error", message: "search failed" })), {
    kind: "error",
    message: "search failed",
  });

  const wireContent = new GrepUnionResult({ result: { case: "content", value: new GrepContentResult({
    matches: [new GrepFileMatch({ file: "/repo/a.ts", matches: [new GrepContentMatch({ lineNumber: 5, content: "needle" })] })],
    totalLines: 1,
    totalMatchedLines: 1,
  }) } });
  assert.deepEqual(grepOutputResultFromInterop(wireContent), {
    kind: "content",
    files: [{ path: "/repo/a.ts", lines: [{ lineNumber: 5, content: "needle", contentTruncated: false, isContextLine: false }] }],
    totalLines: 1,
    totalMatchedLines: 1,
    resultTruncated: false,
    searchTruncated: false,
  });
  const wireCount = new GrepUnionResult({ result: { case: "count", value: { counts: [new GrepFileCount({ file: "/repo/a.ts", count: 2 })], totalFiles: 1, totalMatches: 2 } as never } });
  assert.deepEqual(grepOutputResultFromInterop(wireCount), {
    kind: "count",
    files: [{ path: "/repo/a.ts", matches: 2 }],
    totalFiles: 1,
    totalMatches: 2,
    resultTruncated: false,
    searchTruncated: false,
  });
  assert.deepEqual(grepOutputResultFromInterop(new GrepUnionResult()), { kind: "unrecognized" });
  assert.deepEqual(grepExecutorResultFromInterop(new GrepResult({ result: { case: "error", value: new GrepError({ error: "failed" }) } })), {
    kind: "error",
    message: "failed",
  });
  assert.deepEqual(grepExecutorResultFromInterop(new GrepResult()), { kind: "unrecognized" });
});

test("grep uses Slate values remotely and under controlled execution", async () => {
  const wireSuccess = grepExecutorResultToInterop(success);
  let outgoing: ExecServerMessage | undefined;
  const remote: RemoteExecManager = {
    createExecInstance(_ctx, createMessage) {
      outgoing = createMessage(151);
      return (async function* () {
        yield new ExecClientMessage({ id: 151, message: { case: "grepResult", value: wireSuccess } });
      })();
    },
  };
  assert.deepEqual(await grepExecutorResource.remoteImplementation(remote).execute(context, args), success);
  assert.equal(outgoing?.message.case, "grepArgs");
  if (outgoing?.message.case === "grepArgs") assert.deepEqual(outgoing.message.value, grepExecutorArgsToInterop(args));

  let handler: ControlledExecHandler | undefined;
  let received: GrepExecutorArgs | undefined;
  const implementation: ControlledExecutor<GrepExecutorArgs, GrepExecutorResult> = {
    async execute(_ctx, request) { received = request; return success; },
  };
  grepExecutorResource.registerControlledImplementation(implementation, {
    register(value) { handler = value as ControlledExecHandler; },
  } as ControlledExecManager);
  assert.ok(handler);
  assert.equal(handler.handle(context, new ExecServerMessage({ id: 152, message: { case: "deleteArgs", value: {} } as never })), undefined);
  const stream = handler.handle(context, new ExecServerMessage({ id: 153, message: { case: "grepArgs", value: grepExecutorArgsToInterop(args) } }));
  assert.ok(stream);
  const replies: ExecClientMessage[] = [];
  for await (const reply of stream) replies.push(reply);
  assert.deepEqual(received, {
    ...args,
    sandboxPolicy: {
      type: "workspace_readonly",
      networkPolicy: { version: 1, default: "deny" },
      additionalReadonlyPaths: [],
    },
  });
  assert.equal(replies[0]?.message.case, "grepResult");
  if (replies[0]?.message.case === "grepResult") assert.deepEqual(replies[0].message.value, wireSuccess);
});
