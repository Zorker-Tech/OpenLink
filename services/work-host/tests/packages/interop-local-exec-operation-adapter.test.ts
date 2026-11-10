import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ExecClientMessage,
  ExecServerMessage,
  SpanContext,
} from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import {
  ReadError,
  ReadArgs,
  ReadResult,
  ReadSuccess,
} from "../../source/adapters/interop/proto/generated/agent/v1/read_exec_pb.ts";
import {
  ShellArgs,
  ShellStream,
  ShellStreamExit,
  ShellStreamStderr,
  TimeoutBehavior,
} from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts";
import {
  LsArgs,
  LsDirectoryTreeNode,
  LsDirectoryTreeNode_File,
  LsResult,
  LsSuccess,
} from "../../source/adapters/interop/proto/generated/agent/v1/ls_exec_pb.ts";
import {
  BackgroundShellSpawnArgs,
  BackgroundShellSpawnResult,
  BackgroundShellSpawnSuccess,
} from "../../source/adapters/interop/proto/generated/agent/v1/background_shell_exec_pb.ts";
import { OutputLocation } from "../../source/adapters/interop/proto/generated/agent/v1/utils_pb.ts";
import {
  slateReadRequestFromInterop,
  slateReadRequestToInterop,
  slateReadResultFromInterop,
  slateReadResultToInterop,
  slateBackgroundSpawnRequestFromInterop,
  slateBackgroundSpawnRequestToInterop,
  slateBackgroundSpawnResultFromInterop,
  slateBackgroundSpawnResultToInterop,
  slateListRequestFromInterop,
  slateListRequestToInterop,
  slateListResultFromInterop,
  slateListResultToInterop,
  slateShellRequestFromInterop,
  slateShellRequestToInterop,
  slateShellResultFromInterop,
  slateShellResultToInterop,
} from "../../source/adapters/interop/agent/local-exec-operation-adapter.ts";
import { productionLocalExecCodec } from "../../source/adapters/interop/agent/local-exec-codec-adapter.ts";

describe("Slate local-exec operation interop", () => {
  it("projects a generated read request to Slate names and back without losing envelopes", () => {
    const generated = new ExecServerMessage({
      id: 17,
      execId: "execution-4",
      acceptHookAdditionalContexts: true,
      spanContext: new SpanContext({ traceId: "trace-1", spanId: "span-2", traceFlags: 1 }),
      message: {
        case: "redactedReadArgs",
        value: new ReadArgs({ path: "notes.txt", toolCallId: "tool-3", offset: 2, limit: 5, encodingHint: "utf-8" }),
      },
    });

    const slate = slateReadRequestFromInterop(generated);
    assert.deepEqual(slate, {
      schema: "slate.local-exec.operation.v1",
      id: 17,
      execId: "execution-4",
      acceptHookAdditionalContexts: true,
      trace: { traceId: "trace-1", spanId: "span-2", traceFlags: 1 },
      op: "workspace.read",
      redacted: true,
      args: { path: "notes.txt", toolCallId: "tool-3", offset: 2, limit: 5, encodingHint: "utf-8" },
    });
    assert.deepEqual(slateReadRequestToInterop(slate!), generated);
  });

  it("emits the Slate read schema on the host wire for read operations", () => {
    const generated = new ExecServerMessage({
      id: 3,
      message: { case: "readArgs", value: new ReadArgs({ path: "README.md" }) },
    });
    assert.deepEqual(productionLocalExecCodec.encodeRequest?.(generated as never), {
      schema: "slate.local-exec.operation.v1",
      id: 3,
      op: "workspace.read",
      redacted: false,
      args: { path: "README.md" },
    });
  });

  it("projects generated read outcomes to Slate data and restores the host response", () => {
    const generated = new ExecClientMessage({
      id: 9,
      localExecutionTimeMs: 12,
      message: {
        case: "readResult",
        value: new ReadResult({
          result: {
            case: "success",
            value: new ReadSuccess({
              path: "/work/file.txt",
              output: { case: "data", value: new Uint8Array([1, 2, 3]) },
              totalLines: 0,
              fileSize: 3n,
              truncated: false,
              rangeApplied: false,
            }),
          },
        }),
      },
    });

    const slate = slateReadResultFromInterop(generated);
    assert.deepEqual(slate, {
      schema: "slate.local-exec.operation.v1",
      id: 9,
      localExecutionTimeMs: 12,
      op: "workspace.read.result",
      redacted: false,
      result: {
        kind: "success",
        path: "/work/file.txt",
        body: { kind: "bytes", base64: "AQID" },
        totalLines: 0,
        fileSize: "3",
        truncated: false,
        rangeApplied: false,
      },
    });
    assert.deepEqual(slateReadResultToInterop(slate)?.toJson(), generated.toJson());
    assert.deepEqual(productionLocalExecCodec.decodeClient(slate).toJson(), generated.toJson());
  });

  it("keeps every read failure distinguishable across the owned result schema", () => {
    const generated = new ExecClientMessage({
      id: 4,
      message: {
        case: "readResult",
        value: new ReadResult({
          result: {
            case: "error",
            value: new ReadError({ path: "/work/broken", error: "cannot decode" }),
          },
        }),
      },
    });
    const slate = slateReadResultFromInterop(generated);
    assert.deepEqual(slate?.result, { kind: "error", path: "/work/broken", error: "cannot decode" });
    assert.deepEqual(slateReadResultToInterop(slate), generated);
  });

  it("projects shell arguments and exit data through the Slate operation schema", () => {
    const request = new ExecServerMessage({
      id: 44,
      message: {
        case: "shellStreamArgs",
        value: new ShellArgs({
          command: "printf hello",
          workingDirectory: "work",
          toolCallId: "shell-1",
          timeout: 30,
          timeoutBehavior: TimeoutBehavior.BACKGROUND,
          adminCommandDenylist: ["rm -rf /"],
          skipApproval: true,
          fileOutputThresholdBytes: 4096n,
        }),
      },
    });
    const slateRequest = slateShellRequestFromInterop(request);
    assert.deepEqual(slateRequest, {
      schema: "slate.local-exec.operation.v1",
      id: 44,
      op: "shell.stream",
      args: {
        command: "printf hello",
        workingDirectory: "work",
        toolCallId: "shell-1",
        timeout: 30,
        timeoutBehavior: "background",
        fileOutputThresholdBytes: "4096",
        adminCommandDenylist: ["rm -rf /"],
        skipApproval: true,
      },
    });
    assert.deepEqual(slateShellRequestToInterop(slateRequest!).toJson(), request.toJson());
    assert.deepEqual(productionLocalExecCodec.encodeRequest?.(request as never), slateRequest);

    const response = new ExecClientMessage({
      id: 44,
      localExecutionTimeMs: 7,
      message: {
        case: "shellStream",
        value: new ShellStream({
          event: {
            case: "exit",
            value: new ShellStreamExit({
              code: 0,
              cwd: "/work",
              outputLocation: new OutputLocation({
                filePath: "/work/terminal.txt",
                sizeBytes: 12n,
                lineCount: 2n,
              }),
              aborted: false,
              localExecutionTimeMs: 5,
            }),
          },
        }),
      },
    });
    const slateResponse = slateShellResultFromInterop(response);
    assert.deepEqual(slateResponse?.event, {
      kind: "exit",
      code: 0,
      cwd: "/work",
      outputLocation: { filePath: "/work/terminal.txt", sizeBytes: "12", lineCount: "2" },
      aborted: false,
      localExecutionTimeMs: 5,
    });
    assert.deepEqual(slateShellResultToInterop(slateResponse)?.toJson(), response.toJson());
    assert.deepEqual(productionLocalExecCodec.decodeClient(slateResponse).toJson(), response.toJson());
  });

  it("keeps stderr events as independent shell stream values", () => {
    const generated = new ExecClientMessage({
      id: 8,
      message: {
        case: "shellStream",
        value: new ShellStream({
          event: {
            case: "stderr",
            value: new ShellStreamStderr({ data: "working directory was reset\n" }),
          },
        }),
      },
    });
    const slate = slateShellResultFromInterop(generated);
    assert.deepEqual(slate?.event, { kind: "stderr", data: "working directory was reset\n" });
    assert.deepEqual(slateShellResultToInterop(slate)?.toJson(), generated.toJson());
  });

  it("round-trips directory requests and recursive listing results", () => {
    const request = new ExecServerMessage({
      id: 51,
      message: {
        case: "lsArgs",
        value: new LsArgs({ path: "src", ignore: ["dist"], toolCallId: "ls-1", timeoutMs: 2_000 }),
      },
    });
    const slateRequest = slateListRequestFromInterop(request);
    assert.deepEqual(slateRequest?.args, {
      path: "src",
      ignore: ["dist"],
      toolCallId: "ls-1",
      timeoutMs: 2_000,
    });
    assert.deepEqual(slateListRequestToInterop(slateRequest!).toJson(), request.toJson());

    const result = new ExecClientMessage({
      id: 51,
      message: {
        case: "lsResult",
        value: new LsResult({
          result: {
            case: "success",
            value: new LsSuccess({
              directoryTreeRoot: new LsDirectoryTreeNode({
                absPath: "/work/src",
                childrenFiles: [new LsDirectoryTreeNode_File({ name: "index.ts" })],
                childrenWereProcessed: true,
                fullSubtreeExtensionCounts: { ts: 1 },
                numFiles: 1,
              }),
            }),
          },
        }),
      },
    });
    const slateResult = slateListResultFromInterop(result);
    assert.deepEqual(slateResult?.result, {
      kind: "success",
      root: {
        path: "/work/src",
        directories: [],
        files: [{ name: "index.ts" }],
        processed: true,
        extensionCounts: { ts: 1 },
        numFiles: 1,
      },
    });
    assert.deepEqual(slateListResultToInterop(slateResult)?.toJson(), result.toJson());
  });

  it("round-trips background shell requests and outcomes", () => {
    const request = new ExecServerMessage({
      id: 61,
      message: {
        case: "backgroundShellSpawnArgs",
        value: new BackgroundShellSpawnArgs({
          command: "sleep 30",
          workingDirectory: "work",
          toolCallId: "bg-1",
          enableWriteShellStdinTool: true,
          skipApproval: true,
        }),
      },
    });
    const slateRequest = slateBackgroundSpawnRequestFromInterop(request);
    assert.deepEqual(slateRequest?.args, {
      command: "sleep 30",
      workingDirectory: "work",
      toolCallId: "bg-1",
      enableWriteShellStdinTool: true,
      skipApproval: true,
    });
    assert.deepEqual(slateBackgroundSpawnRequestToInterop(slateRequest!).toJson(), request.toJson());

    const result = new ExecClientMessage({
      id: 61,
      message: {
        case: "backgroundShellSpawnResult",
        value: new BackgroundShellSpawnResult({
          result: {
            case: "success",
            value: new BackgroundShellSpawnSuccess({
              shellId: 9,
              command: "sleep 30",
              workingDirectory: "/work",
              pid: 123,
            }),
          },
        }),
      },
    });
    const slateResult = slateBackgroundSpawnResultFromInterop(result);
    assert.deepEqual(slateResult?.result, {
      kind: "success",
      shellId: 9,
      command: "sleep 30",
      workingDirectory: "/work",
      pid: 123,
    });
    assert.deepEqual(slateBackgroundSpawnResultToInterop(slateResult)?.toJson(), result.toJson());
  });
});
