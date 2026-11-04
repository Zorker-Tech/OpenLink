import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseBoxEnvironmentUpdate,
  parseBoxEnvironmentUpdateResult,
  parseBoxMcpLoadRequest,
  parseBoxMcpLoadResult,
  parseBoxPingResult,
} from "../../source/shared/box-control-protocol.ts";
import {
  parseBoxExecRequest,
  parseBoxExecResponse,
} from "../../source/shared/box-exec-protocol.ts";

describe("Slate box protocols", () => {
  it("validates control payloads without accepting malformed environment names", () => {
    assert.deepEqual(parseBoxPingResult({ ok: true }), { ok: true });
    assert.deepEqual(parseBoxEnvironmentUpdate({
      env: { SLATE_MODE: "release" },
      replace: true,
    }), { env: { SLATE_MODE: "release" }, replace: true });
    assert.deepEqual(parseBoxEnvironmentUpdateResult({ applied: 1, removed: 2 }), { applied: 1, removed: 2 });
    assert.deepEqual(parseBoxMcpLoadRequest({ configurationJson: "{}" }), { configurationJson: "{}" });
    assert.deepEqual(parseBoxMcpLoadResult({ loadedServerNames: [] }), { loadedServerNames: [] });
    assert.throws(
      () => parseBoxEnvironmentUpdate({ env: { "BAD=NAME": "x" }, replace: true }),
      /environment update is invalid/,
    );
  });

  it("validates box execution requests and streamed responses", () => {
    assert.deepEqual(parseBoxExecRequest({
      schema: "slate.box-exec.operation.v1",
      id: 4,
      op: "workspace.read",
      redacted: false,
      path: "/workspace/note.txt",
      limit: 3,
    }), {
      schema: "slate.box-exec.operation.v1",
      id: 4,
      op: "workspace.read",
      redacted: false,
      path: "/workspace/note.txt",
      limit: 3,
    });
    assert.deepEqual(parseBoxExecResponse({
      schema: "slate.box-exec.operation.v1",
      id: 4,
      kind: "shell.stream",
      event: { kind: "stdout", data: "ok\n" },
    }), {
      schema: "slate.box-exec.operation.v1",
      id: 4,
      kind: "shell.stream",
      event: { kind: "stdout", data: "ok\n" },
    });
    assert.throws(() => parseBoxExecRequest({
      schema: "slate.box-exec.operation.v1",
      id: 4,
      op: "unknown",
    }), /box exec request is invalid/);
  });
});
