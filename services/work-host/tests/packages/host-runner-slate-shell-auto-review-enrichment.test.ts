import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  SLATE_SHELL_APPROVAL_HASH_CHUNK_LINES,
  SLATE_SHELL_APPROVAL_HASH_MAX_LINES,
  SLATE_SHELL_APPROVAL_PARSE_MAX_CHARS,
  SLATE_SHELL_ENRICHMENT_MAX_CHARS,
  SLATE_SHELL_ENRICHMENT_MAX_LINES,
  buildSlateShellAutoReviewTargetEnrichment,
  hashFullText,
  parseSlateShellEnrichmentCandidate,
  readBoundedText,
  unavailableBinding,
  unquote,
} from "../../source/host/runner/slate-shell-auto-review-enrichment.ts";

interface ReadAnswer { kind: "content" | "other" | "failure"; content?: string; totalLines?: number; truncated?: boolean }
function accessor(answers: ReadAnswer[], calls: any[]) {
  return {
    async read(context: unknown, args: { path: string; toolCallId: string; offset: number; limit: number }) {
      calls.push({ context, ...args });
      const answer = answers.shift() ?? { kind: "failure" };
      if (answer.kind !== "content") return undefined;
      return { content: answer.content ?? "", totalLines: answer.totalLines ?? 0, truncated: answer.truncated ?? false };
    },
  };
}

describe("parsing the command a shell review is about", () => {
  it("keeps its bounds", () => {
    assert.deepEqual([SLATE_SHELL_ENRICHMENT_MAX_CHARS, SLATE_SHELL_ENRICHMENT_MAX_LINES, SLATE_SHELL_APPROVAL_HASH_CHUNK_LINES, SLATE_SHELL_APPROVAL_HASH_MAX_LINES, SLATE_SHELL_APPROVAL_PARSE_MAX_CHARS], [8_000, 200, 50, 20_000, 1_000_000]);
    assert.equal(unquote("\"quoted\""), "quoted");
    assert.equal(unquote("'single'"), "single");
    assert.equal(unquote("\"mixed'"), "\"mixed'");
    assert.equal(unquote("plain"), "plain");
  });

  it("finds the executable a command names", () => {
    assert.deepEqual(parseSlateShellEnrichmentCandidate("node script.js", "/work"), { kind: "executable", path: "/work/script.js" });
    assert.deepEqual(parseSlateShellEnrichmentCandidate("python3.11 tool.py", "/work"), { kind: "executable", path: "/work/tool.py" });
    assert.deepEqual(parseSlateShellEnrichmentCandidate("/usr/bin/env", "/work"), { kind: "executable", path: "/usr/bin/env" });
    assert.deepEqual(parseSlateShellEnrichmentCandidate("./script.sh", "/work"), { kind: "executable", path: "/work/script.sh" });
    assert.deepEqual(parseSlateShellEnrichmentCandidate("FOO=1 node script.js", "/work"), { kind: "executable", path: "/work/script.js" });
    assert.deepEqual(parseSlateShellEnrichmentCandidate("cd sub && node script.js", "/work"), { kind: "executable", path: "/work/sub/script.js" });
    assert.deepEqual(parseSlateShellEnrichmentCandidate("cd \"sub dir\" && node script.js", "/work"), { kind: "executable", path: "/work/sub dir/script.js" });
    assert.equal(parseSlateShellEnrichmentCandidate("node script.js"), undefined, "a relative executable needs a directory");
    assert.equal(parseSlateShellEnrichmentCandidate("echo hi", "/work"), undefined);
  });

  it("finds the package script a command names", () => {
    assert.deepEqual(parseSlateShellEnrichmentCandidate("npm run build", "/work"), { kind: "package_script", packageJsonPath: "/work/package.json", scriptName: "build" });
    assert.deepEqual(parseSlateShellEnrichmentCandidate("pnpm run test", "/work"), { kind: "package_script", packageJsonPath: "/work/package.json", scriptName: "test" });
    assert.deepEqual(parseSlateShellEnrichmentCandidate("yarn run dev", "/work"), { kind: "package_script", packageJsonPath: "/work/package.json", scriptName: "dev" });
    assert.deepEqual(parseSlateShellEnrichmentCandidate("npm install", "/work"), { kind: "package_script", packageJsonPath: "/work/package.json", scriptName: "install" }, "a package manager word is read as a script name");
    assert.deepEqual(parseSlateShellEnrichmentCandidate("npm run build"), { kind: "package_script_unresolved", invocation: "npm run build" });
    assert.deepEqual(parseSlateShellEnrichmentCandidate("echo hi && npm run build", "/work"), { kind: "package_script_unresolved", packageJsonPath: "/work/package.json", invocation: "echo hi && npm run build" });
  });
});

describe("reading what a shell review needs", () => {
  it("reads bounded text through the resource accessor", async () => {
    const calls: any[] = [];
    assert.deepEqual(await readBoundedText("CTX" as never, accessor([{ kind: "content", content: "hello", totalLines: 1 }], calls) as never, "/work/file.txt", "call-1"), { content: "hello", totalLines: 1, truncated: false });
    assert.deepEqual(calls[0], { context: "CTX", path: "/work/file.txt", toolCallId: "call-1", offset: 1, limit: 200 });
    assert.deepEqual(await readBoundedText("CTX" as never, accessor([{ kind: "content", content: "hello", totalLines: 500 }], []) as never, "/work/file.txt", "call-1"), { content: "hello", totalLines: 500, truncated: true });
    assert.equal(await readBoundedText("CTX" as never, accessor([{ kind: "failure" }], []) as never, "/work/file.txt", "call-1"), undefined);
    assert.equal(await readBoundedText("CTX" as never, accessor([{ kind: "other" }], []) as never, "/work/file.txt", "call-1"), undefined);
  });

  it("hashes the full text in chunks", async () => {
    const calls: any[] = [];
    const one = await hashFullText("CTX" as never, accessor([{ kind: "content", content: "line one\n", totalLines: 1 }], calls) as never, "/work/file.txt", "call-1", 1);
    assert.equal(typeof one?.definitionHash, "string");
    assert.equal(one?.fullContent, "line one\n");
    assert.equal(one?.definitionHash, createHash("sha256").update("1").update("\0").update("line one\n").update("\0").digest("hex"), "the offset and the text are both hashed");
    assert.deepEqual(calls.map((call) => call.offset), [1]);
    const chunkCalls: any[] = [];
    const two = await hashFullText("CTX" as never, accessor([{ kind: "content", content: "a".repeat(10), totalLines: 60 }, { kind: "content", content: "b".repeat(10), totalLines: 60 }], chunkCalls) as never, "/work/file.txt", "call-1", 60);
    assert.equal(two?.fullContent, "aaaaaaaaaabbbbbbbbbb");
    assert.deepEqual(chunkCalls.map((call) => call.offset), [1, 51]);
    assert.equal(await hashFullText("CTX" as never, accessor([], []) as never, "/work/file.txt", "call-1", 20_001), undefined);
    assert.equal(await hashFullText("CTX" as never, accessor([{ kind: "content", content: "a", totalLines: 60, truncated: true }], []) as never, "/work/file.txt", "call-1", 60), undefined);
  });

  it("describes an unavailable approval binding", () => {
    const executable = unavailableBinding({ kind: "executable", path: "/work/script.sh" });
    assert.deepEqual([executable.kind, executable.path, (executable as { approval_binding_unavailable?: unknown }).approval_binding_unavailable, typeof (executable as { approval_binding_nonce?: unknown }).approval_binding_nonce], ["executable", "/work/script.sh", true, "string"]);
    assert.equal(unavailableBinding({ kind: "package_script", packageJsonPath: "/work/package.json", scriptName: "build" }).path, "/work/package.json");
    assert.equal(unavailableBinding({ kind: "package_script_unresolved", invocation: "npm run build" }).path, "npm run build");
  });

  it("builds the whole enrichment for an executable and a package script", async () => {
    const executableCalls: any[] = [];
    const executable = await buildSlateShellAutoReviewTargetEnrichment("CTX" as never, {
      command: "node /work/script.sh",
      workingDirectory: "/work",
      resourceAccessor: accessor([{ kind: "content", content: "#!/bin/sh\n", totalLines: 1 }, { kind: "content", content: "#!/bin/sh\n", totalLines: 1 }], executableCalls) as never,
      toolCallId: "call-1",
    });
    assert.deepEqual([executable?.kind, executable?.path, (executable as { definition?: unknown })?.definition, (executable as { truncated?: unknown })?.truncated], ["executable", "/work/script.sh", "#!/bin/sh\n", false]);
    assert.equal(typeof (executable as { definition_hash?: unknown }).definition_hash, "string");
    const packageJson = JSON.stringify({ scripts: { build: "tsc -p ." } });
    const script = await buildSlateShellAutoReviewTargetEnrichment("CTX" as never, {
      command: "npm run build",
      workingDirectory: "/work",
      resourceAccessor: accessor([{ kind: "content", content: packageJson, totalLines: 1 }, { kind: "content", content: packageJson, totalLines: 1 }], []) as never,
      toolCallId: "call-1",
    });
    assert.deepEqual([script?.kind, script?.path, (script as { name?: unknown }).name, (script as { definition?: unknown }).definition, (script as { truncated?: unknown })?.truncated], ["package_script", "/work/package.json", "build", "tsc -p .", false]);
    const unresolved = await buildSlateShellAutoReviewTargetEnrichment("CTX" as never, { command: "npm run build", resourceAccessor: accessor([], []) as never, toolCallId: "call-1" });
    assert.deepEqual([unresolved?.kind, (unresolved as { approval_binding_unavailable?: unknown }).approval_binding_unavailable, (unresolved as { path?: unknown }).path], ["package_script_unresolved", true, "npm run build"]);
    assert.equal(await buildSlateShellAutoReviewTargetEnrichment("CTX" as never, { command: "echo hi", workingDirectory: "/work", resourceAccessor: accessor([], []) as never, toolCallId: "call-1" }), undefined);
    const truncated = await buildSlateShellAutoReviewTargetEnrichment("CTX" as never, {
      command: "node /work/script.sh",
      workingDirectory: "/work",
      resourceAccessor: accessor([{ kind: "content", content: "x".repeat(9_000), totalLines: 1, truncated: true }, { kind: "content", content: "x".repeat(9_000), totalLines: 1 }], []) as never,
      toolCallId: "call-1",
    });
    assert.deepEqual([truncated?.kind, (truncated as { approval_binding_unavailable?: unknown }).approval_binding_unavailable], ["executable", true], "a truncated executable is not described");
    const missingScript = await buildSlateShellAutoReviewTargetEnrichment("CTX" as never, {
      command: "npm run missing",
      workingDirectory: "/work",
      resourceAccessor: accessor([{ kind: "content", content: packageJson, totalLines: 1 }, { kind: "content", content: packageJson, totalLines: 1 }], []) as never,
      toolCallId: "call-1",
    });
    assert.deepEqual([missingScript?.kind, (missingScript as { approval_binding_unavailable?: unknown }).approval_binding_unavailable], ["package_script", true]);
  });
});
