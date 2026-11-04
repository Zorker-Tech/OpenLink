import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SLATE_LOCAL_EXEC_PROTOCOL_VERSION,
  isCurrentLocalExecProtocol,
  parseLocalExecRequestFrame,
  parseLegacyLocalExecRequestFrame,
  parseLocalExecReadRequest,
  parseLocalExecReadResult,
  parseLocalExecResponseBatch,
  parseLocalExecResponseFrame,
  parseLocalExecBackgroundSpawnRequest,
  parseLocalExecBackgroundSpawnResult,
  parseLocalExecListRequest,
  parseLocalExecListResult,
  parseLocalExecShellRequest,
  parseLocalExecShellResult,
} from "../../source/shared/local-exec-protocol.ts";

describe("Slate local-exec wire protocol", () => {
  it("accepts versioned connection and execution frames", () => {
    assert.deepEqual(parseLocalExecRequestFrame({
      kind: "welcome",
      providerId: "provider-1",
      protocolVersion: SLATE_LOCAL_EXEC_PROTOCOL_VERSION,
    }), {
      kind: "welcome",
      providerId: "provider-1",
      protocolVersion: SLATE_LOCAL_EXEC_PROTOCOL_VERSION,
    });

    assert.deepEqual(parseLocalExecRequestFrame({
      kind: "exec",
      requestId: "request-1",
      approvalId: "approval-1",
      serverMessage: {
        schema: "slate.local-exec.operation.v1",
        id: 4,
        op: "workspace.read",
        redacted: false,
        args: { path: "README.md" },
      },
    }), {
      kind: "exec",
      requestId: "request-1",
      approvalId: "approval-1",
      serverMessage: {
        schema: "slate.local-exec.operation.v1",
        id: 4,
        op: "workspace.read",
      },
    });
  });

  it("keeps an unversioned connection readable as legacy compatibility", () => {
    const frame = parseLocalExecRequestFrame({ kind: "welcome", providerId: "provider-old" });
    assert.equal(isCurrentLocalExecProtocol(frame), false);
    assert.deepEqual(parseLegacyLocalExecRequestFrame({
      kind: "exec",
      requestId: "legacy-request",
      serverMessage: { readArgs: { path: "README.md" } },
    }), {
      kind: "exec",
      requestId: "legacy-request",
      serverMessage: { readArgs: { path: "README.md" } },
    });
  });

  it("recognizes the current protocol marker", () => {
    assert.equal(isCurrentLocalExecProtocol({ protocolVersion: 1 }), true);
    assert.equal(isCurrentLocalExecProtocol({}), false);
  });

  it("rejects unknown operations, missing identifiers and non-JSON payloads", () => {
    assert.throws(() => parseLocalExecRequestFrame({ kind: "unknown" }), /local-exec request frame is invalid/);
    assert.throws(() => parseLocalExecRequestFrame({ kind: "exec", requestId: "", serverMessage: {} }), /requestId/);
    assert.throws(
      () => parseLocalExecRequestFrame({ kind: "exec", requestId: "r", serverMessage: { value: Number.NaN } }),
      /serverMessage/,
    );
  });

  it("validates response frames and their provider batch", () => {
    const hello = parseLocalExecResponseFrame({
      kind: "hello",
      localRoot: "/work",
      terminalsFolder: "/work/terminals",
      computerId: "machine-1",
      label: "Machine one",
      protocolVersion: SLATE_LOCAL_EXEC_PROTOCOL_VERSION,
    });
    assert.equal(isCurrentLocalExecProtocol(hello), true);
    assert.deepEqual(parseLocalExecResponseBatch({ providerId: "provider-1", frames: [hello] }), {
      providerId: "provider-1",
      frames: [hello],
    });
  });

  it("rejects malformed file data instead of decoding it approximately", () => {
    assert.throws(() => parseLocalExecRequestFrame({
      kind: "upload",
      requestId: "request-1",
      path: "notes.txt",
      bytesBase64: "not base64!",
    }), /bytesBase64/);
    assert.deepEqual(parseLocalExecRequestFrame({
      kind: "upload",
      requestId: "request-1",
      path: "notes.txt",
      bytesBase64: "U2xhdGU=",
    }), {
      kind: "upload",
      requestId: "request-1",
      path: "notes.txt",
      bytesBase64: "U2xhdGU=",
    });
  });

  it("defines the Slate read operation and result independently from generated executor messages", () => {
    const request = parseLocalExecReadRequest({
      schema: "slate.local-exec.operation.v1",
      id: 7,
      op: "workspace.read",
      redacted: false,
      args: { path: "README.md", offset: 0, limit: 40 },
    });
    assert.deepEqual(request?.args, { path: "README.md", offset: 0, limit: 40 });

    const result = parseLocalExecReadResult({
      schema: "slate.local-exec.operation.v1",
      id: 7,
      op: "workspace.read.result",
      redacted: false,
      result: {
        kind: "success",
        path: "/work/README.md",
        body: { kind: "text", text: "# Slate\n" },
        totalLines: 1,
        fileSize: "8",
        truncated: false,
        rangeApplied: true,
      },
    });
    assert.equal(result?.result.kind, "success");
    assert.equal(parseLocalExecReadResult({ ...result, op: "workspace.write.result" }), undefined);
  });

  it("defines shell requests and streamed events with Slate failure categories", () => {
    assert.deepEqual(parseLocalExecShellRequest({
      schema: "slate.local-exec.operation.v1",
      id: 9,
      op: "shell.stream",
      args: {
        command: "printf hello",
        workingDirectory: "work",
        timeout: 30,
        timeoutBehavior: "background",
        requestedSandboxPolicy: {
          type: "workspace_readonly",
          networkPolicy: { default: "deny", allow: ["registry.example.test"] },
        },
      },
    })?.args, {
      command: "printf hello",
      workingDirectory: "work",
      timeout: 30,
      timeoutBehavior: "background",
      requestedSandboxPolicy: {
        type: "workspace_readonly",
        networkPolicy: { default: "deny", allow: ["registry.example.test"] },
      },
    });

    assert.deepEqual(parseLocalExecShellResult({
      schema: "slate.local-exec.operation.v1",
      id: 9,
      op: "shell.stream.result",
      event: {
        kind: "exit",
        code: 1,
        cwd: "/work",
        aborted: false,
        outputLocation: { filePath: "/work/out.txt", sizeBytes: "12", lineCount: "2" },
      },
    })?.event, {
      kind: "exit",
      code: 1,
      cwd: "/work",
      aborted: false,
      outputLocation: { filePath: "/work/out.txt", sizeBytes: "12", lineCount: "2" },
    });
    assert.equal(parseLocalExecShellResult({
      schema: "slate.local-exec.operation.v1",
      id: 9,
      op: "shell.stream.result",
      event: { kind: "unknown" },
    }), undefined);
  });

  it("defines directory listings and background shell outcomes without generated envelopes", () => {
    assert.deepEqual(parseLocalExecListRequest({
      schema: "slate.local-exec.operation.v1",
      id: 11,
      op: "workspace.list",
      args: { path: "src", ignore: ["dist"], timeoutMs: 2000 },
    })?.args, { path: "src", ignore: ["dist"], timeoutMs: 2000 });
    assert.deepEqual(parseLocalExecListResult({
      schema: "slate.local-exec.operation.v1",
      id: 11,
      op: "workspace.list.result",
      result: {
        kind: "success",
        root: {
          path: "/work/src",
          directories: [],
          files: [{ name: "index.ts" }],
          processed: true,
          extensionCounts: { ts: 1 },
          numFiles: 1,
        },
      },
    })?.result.kind, "success");

    assert.deepEqual(parseLocalExecBackgroundSpawnRequest({
      schema: "slate.local-exec.operation.v1",
      id: 12,
      op: "shell.background.spawn",
      args: { command: "sleep 30", workingDirectory: "work", enableWriteShellStdinTool: true },
    })?.args, {
      command: "sleep 30",
      workingDirectory: "work",
      enableWriteShellStdinTool: true,
    });
    assert.deepEqual(parseLocalExecBackgroundSpawnResult({
      schema: "slate.local-exec.operation.v1",
      id: 12,
      op: "shell.background.spawn.result",
      result: { kind: "success", shellId: 4, command: "sleep 30", workingDirectory: "/work", pid: 88 },
    })?.result, {
      kind: "success",
      shellId: 4,
      command: "sleep 30",
      workingDirectory: "/work",
      pid: 88,
    });
  });
});
