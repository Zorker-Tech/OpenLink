import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createContext } from "../../source/packages/context/context.ts";
import {
  authorizeLocalToolAction,
  isTerminalFile,
  localToolApprovalCovers,
  normalizeLocalToolResourcePath,
  SlateLocalToolPermissionDeniedError,
  slateLocalToolScopeKey,
  slateTerminalFilePath,
  slateTurnDirectionEpochKey,
  describeLocalExec,
} from "../../source/shared/local-tool-permission-machinery.ts";

describe("Slate local-tool permission machinery", () => {
  it("keeps permission scope and direction epoch on the context that owns them", () => {
    const context = createContext();
    const scope = { agentId: "agent-1", toolCallId: "call-1", action: "run-command" as const };
    const scoped = context.with(slateLocalToolScopeKey, scope).with(slateTurnDirectionEpochKey, 7);
    assert.equal(context.get(slateLocalToolScopeKey), undefined);
    assert.deepEqual(scoped.get(slateLocalToolScopeKey), scope);
    assert.equal(scoped.get(slateTurnDirectionEpochKey), 7);
  });

  it("returns an approval id for allowed work and preserves the denial reason", async () => {
    const request = { action: "read-file" as const, target: "/workspace/a.txt" };
    assert.equal(await authorizeLocalToolAction({ authorize: async () => ({ allowed: true, reason: "approved", approvalId: "approval-1" }) }, undefined, request), "approval-1");
    await assert.rejects(
      () => authorizeLocalToolAction({ authorize: async () => ({ allowed: false, reason: "The user declined it." }) }, undefined, request),
      (error: unknown) => error instanceof SlateLocalToolPermissionDeniedError && error.reason === "The user declined it.",
    );
  });

  it("normalizes resource separators and omits empty paths", () => {
    assert.equal(normalizeLocalToolResourcePath("C:\\Users\\Ada\\"), "C:/Users/Ada/");
    assert.equal(normalizeLocalToolResourcePath(""), undefined);
    assert.equal(normalizeLocalToolResourcePath(undefined), undefined);
  });

  it("recognizes only direct terminal text files and builds their paths", () => {
    assert.equal(slateTerminalFilePath("/tmp/terminals/", "shell-1"), "/tmp/terminals/shell-1.txt");
    assert.equal(slateTerminalFilePath("/tmp/terminals", ""), undefined);
    assert.equal(isTerminalFile("\\tmp\\terminals\\shell-1.txt", "/tmp/terminals/"), true);
    assert.equal(isTerminalFile("/tmp/terminals/nested/shell-1.txt", "/tmp/terminals"), false);
    assert.equal(isTerminalFile("/tmp/terminals/shell-1.log", "/tmp/terminals"), false);
    assert.equal(isTerminalFile("/tmp/elsewhere/shell-1.txt", "/tmp/terminals"), false);
  });

  it("describes supported local-exec requests and leaves unknown messages without an approval", () => {
    const terminals = "/tmp/terminals";
    assert.deepEqual(describeLocalExec({ message: { case: "shellStreamArgs", value: { command: "pwd" } } }, terminals), {
      action: "run-command", target: "pwd", resourcePath: terminals,
    });
    assert.deepEqual(describeLocalExec({ message: { case: "backgroundShellSpawnArgs", value: { command: "sleep 5" } } }, terminals), {
      action: "run-command", target: "sleep 5", resourcePath: terminals, outlivesScope: true,
    });
    assert.deepEqual(describeLocalExec({ message: { case: "forceBackgroundShellArgs", value: {} } }, terminals), {
      action: "run-command", target: "a command already running", attachToResourcePath: terminals, outlivesScope: true,
    });
    assert.deepEqual(describeLocalExec({ message: { case: "writeShellStdinArgs", value: { chars: "q" } } }, terminals), {
      action: "send-input", target: "q",
    });
    assert.deepEqual(describeLocalExec({ message: { case: "redactedReadArgs", value: { path: "/tmp/terminals/shell-1.txt" } } }, terminals), {
      action: "read-file", target: "/tmp/terminals/shell-1.txt", attachToResourcePath: terminals,
    });
    assert.deepEqual(describeLocalExec({ message: { case: "readArgs", value: { path: "/workspace/a.txt" } } }, terminals), {
      action: "read-file", target: "/workspace/a.txt",
    });
    assert.deepEqual(describeLocalExec({ message: { case: "lsArgs", value: { path: "/workspace" } } }, terminals), {
      action: "list-directory", target: "/workspace",
    });
    assert.equal(describeLocalExec({ message: { case: "unknown", value: {} } }, terminals), undefined);
    assert.equal(describeLocalExec({ message: { case: "toString", value: {} } }, terminals), undefined);
    assert.equal(describeLocalExec({ message: { case: "constructor", value: {} } }, terminals), undefined);
  });

  it("reuses an approval only for its exact action or the resource it owns", () => {
    const exact = { action: "run-command" as const, target: "pwd" };
    assert.equal(localToolApprovalCovers(exact, exact), true);
    assert.equal(localToolApprovalCovers(exact, { action: "run-command", target: "ls" }), false);
    assert.equal(localToolApprovalCovers(
      { action: "run-command", target: "sleep 5", resourcePath: "C:\\terminals\\" },
      { action: "send-input", target: "q", attachToResourcePath: "C:/terminals/" },
    ), true);
    assert.equal(localToolApprovalCovers(
      { action: "run-command", target: "sleep 5", resourcePath: "/tmp/terminals" },
      { action: "send-input", target: "q", attachToResourcePath: "/tmp/other" },
    ), false);
  });
});
