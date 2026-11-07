import assert from "node:assert/strict";
import { test } from "node:test";

import { ReadArgs, ReadResult, ReadSuccess } from "../../source/adapters/interop/proto/generated/agent/v1/read_exec_pb.ts";
import {
  readExecutorArgsFromInterop,
  readExecutorArgsToInterop,
  readExecutorResultFromInterop,
  readExecutorResultToInterop,
} from "../../source/adapters/interop/agent/read-exec-operation-adapter.ts";
import type { ReadExecutorArgs, ReadExecutorResult } from "../../source/packages/agent-exec/read-operation.ts";

test("Slate read requests preserve every supported read option at the transport boundary", () => {
  const request: ReadExecutorArgs = {
    path: "/workspace/notes.txt",
    toolCallId: "read-42",
    offset: -8,
    limit: 0,
    encodingHint: "utf-16le",
  };
  const wire = readExecutorArgsToInterop(request);
  assert.deepEqual(readExecutorArgsFromInterop(wire), request);
  assert.deepEqual(wire, new ReadArgs(request));
});

test("Slate read results preserve large file sizes, both output forms and output blobs", () => {
  const largeFileSize = 9_007_199_254_740_997n;
  const blobId = new Uint8Array([5, 4, 3, 2, 1]);
  const text: ReadExecutorResult = {
    kind: "success",
    path: "/workspace/notes.txt",
    output: { kind: "text", text: "one\ntwo" },
    totalLines: 2,
    fileSize: largeFileSize,
    truncated: true,
    outputBlobId: blobId,
    rangeApplied: true,
  };
  const bytes: ReadExecutorResult = {
    kind: "success",
    path: "/workspace/archive.pdf",
    output: { kind: "data", bytes: new Uint8Array([0, 255, 1]) },
    totalLines: 0,
    fileSize: 3n,
    truncated: false,
    rangeApplied: false,
  };
  const withoutOutput: ReadExecutorResult = {
    kind: "success",
    path: "/workspace/opaque.bin",
    totalLines: 0,
    fileSize: 0n,
    truncated: false,
    rangeApplied: false,
  };

  for (const result of [text, bytes, withoutOutput]) {
    assert.deepEqual(readExecutorResultFromInterop(readExecutorResultToInterop(result)), result);
  }
});

test("Slate read failures retain their distinct meaning and path", () => {
  const failures: ReadExecutorResult[] = [
    { kind: "error", path: "/workspace/a.txt", error: "disk error" },
    { kind: "rejected", path: "/workspace/a.txt", reason: "outside policy" },
    { kind: "not-found", path: "/workspace/missing.txt" },
    { kind: "permission-denied", path: "/workspace/private.txt" },
    { kind: "invalid-file", path: "/workspace/folder", reason: "not a regular file" },
  ];

  for (const failure of failures) {
    assert.deepEqual(readExecutorResultFromInterop(readExecutorResultToInterop(failure)), failure);
  }
  assert.deepEqual(readExecutorResultFromInterop(new ReadResult()), { kind: "unrecognized" });
  assert.deepEqual(readExecutorResultToInterop({ kind: "unrecognized" }), new ReadResult());
});

test("a Slate read success can be projected without an output oneof", () => {
  const result = readExecutorResultFromInterop(new ReadResult({
    result: { case: "success", value: new ReadSuccess({ path: "/workspace/empty", fileSize: 0n }) },
  }));
  assert.deepEqual(result, {
    kind: "success",
    path: "/workspace/empty",
    totalLines: 0,
    fileSize: 0n,
    truncated: false,
    rangeApplied: false,
  });
});
