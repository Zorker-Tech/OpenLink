import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, it } from "node:test";

import type { Context } from "../../source/packages/context/context.ts";
import { createContext } from "../../source/packages/context/context.ts";
import { LocalLsExecutor, MissingLsTraversalBindingError } from "../../source/packages/local-exec/ls.ts";
import type { LocalLsOutcome } from "../../source/packages/local-exec/ls.ts";

interface IgnoreRules {
  listWorkspaceIgnoreFilesByRoot(root: string): Promise<readonly string[]>;
  getRepoBlockExcludeGlobs(root: string): Promise<readonly string[]>;
  isRepoBlocked(path: string): Promise<boolean> | boolean;
}

function withRoot(run: (rootDir: string) => Promise<void>): Promise<void> {
  const rootDir = mkdtempSync(join(tmpdir(), "slate-local-ls-contract-"));
  return run(rootDir).finally(() => rmSync(rootDir, { recursive: true, force: true }));
}

function ignoreRules(overrides: Partial<IgnoreRules> = {}): IgnoreRules {
  return {
    listWorkspaceIgnoreFilesByRoot: async () => [],
    getRepoBlockExcludeGlobs: async () => [],
    isRepoBlocked: () => false,
    ...overrides,
  };
}

function traversal(lines: readonly string[], didTimeout = false, onWalk?: (context: Context, args: Record<string, unknown>) => void) {
  return {
    walk(context: Context, args: Record<string, unknown>) {
      onWalk?.(context, args);
      return {
        lines: (async function* () { yield* lines; })(),
        didTimeout: Promise.resolve(didTimeout),
      };
    },
    resolveForIgnore: async (path: string): Promise<string | null> => path,
  };
}

function treeOf(result: LocalLsOutcome) {
  if (result.kind !== "success" && result.kind !== "timeout") throw new Error("expected a directory tree")
  if (result.root === undefined) throw new Error("expected the directory tree root")
  return result.root
}

describe("the local directory listing", () => {
  it("passes root, ignore globs, cursor files, sandbox policy and source to traversal", async () => {
    await withRoot(async (rootDir) => {
      const resolvedPaths: string[] = [];
      const blockedChecks: string[] = [];
      const walkArgs: Array<Record<string, unknown>> = [];
      const ignore = ignoreRules({
        listWorkspaceIgnoreFilesByRoot: async (root) => [`${root}/.cursorignore`],
        getRepoBlockExcludeGlobs: async () => ["vendor/**"],
        isRepoBlocked: (path) => { blockedChecks.push(path); return path.includes("blocked"); },
      });
      const run = traversal(["src/a.ts", "blocked/secret.txt", "ignored/secret.md", "", "docs/readme.md"], false, (_ctx, args) => walkArgs.push(args));
      run.resolveForIgnore = async (path: string) => {
        resolvedPaths.push(path);
        return path.includes("ignored") ? null : path;
      };
      const executor = new LocalLsExecutor(undefined, ignore, rootDir, run as never);
      const sandboxPolicy = { type: "workspace_readonly" as const };
      const result = await executor.execute(createContext(), { path: ".", ignore: ["tmp/**"], sandboxPolicy });

      assert.equal(result.kind, "success");
      assert.deepEqual(walkArgs[0], {
        root: resolve(rootDir),
        excludeGlobs: ["tmp/**", "vendor/**"],
        workspaceIgnoreFiles: [`${resolve(rootDir)}/.cursorignore`],
        sandboxPolicy,
        source: "ls",
      });
      const root = treeOf(result);
      assert.deepEqual(root.childrenDirs.map((node: { absPath: string }) => basename(node.absPath)), ["docs", "src"]);
      assert.deepEqual(resolvedPaths.map((path) => basename(path)), ["a.ts", "secret.txt", "secret.md", "readme.md"]);
      assert.deepEqual(blockedChecks.map((path) => basename(path)), ["a.ts", "secret.txt", "readme.md"]);
      assert.deepEqual(root.childrenDirs.flatMap((node) => node.childrenFiles.map((file) => file.name)), ["readme.md", "a.ts"]);
    });
  });

  it("uses a caller timeout and returns a timeout result with the partial tree", async () => {
    await withRoot(async (rootDir) => {
      let receivedContext: Context | undefined;
      let timeoutMs: number | undefined;
      const child = {} as Context;
      const parent = { withTimeout: (ms: number) => { timeoutMs = ms; return child; } } as unknown as Context;
      const run = traversal(["src/partial.ts"], true, (context) => { receivedContext = context; });
      const executor = new LocalLsExecutor(undefined, ignoreRules(), rootDir, run as never);
      const result = await executor.execute(parent, { path: ".", timeoutMs: 123 });
      assert.equal(timeoutMs, 123);
      assert.equal(receivedContext, child);
      assert.equal(result.kind, "timeout");
      assert.deepEqual(treeOf(result).childrenDirs.map((node) => node.childrenFiles.map((file) => file.name)), [["partial.ts"]]);
    });
  });

  it("reports a missing path and a regular file as distinct errors", async () => {
    await withRoot(async (rootDir) => {
      const filePath = join(rootDir, "note.txt");
      writeFileSync(filePath, "hello");
      const executor = new LocalLsExecutor(undefined, ignoreRules(), rootDir, traversal([]) as never);

      const missing = await executor.execute(createContext(), { path: "not-there" });
      assert.equal(missing.kind, "error");
      if (missing.kind !== "error") assert.fail("expected an ls error");
      assert.equal(missing.error, `Path does not exist: ${join(rootDir, "not-there")}`);
      const notDirectory = await executor.execute(createContext(), { path: "note.txt" });
      assert.equal(notDirectory.kind, "error");
      if (notDirectory.kind !== "error") assert.fail("expected an ls error");
      assert.equal(notDirectory.error, `Path is not a directory: ${filePath}`);
    });
  });

  it("marks exactly the file that fits and still counts files omitted after the character budget", async () => {
    await withRoot(async (rootDir) => {
      const budgetedName = `${"x".repeat(2_500 - resolve(rootDir).length - 3)}.ts`;
      const executor = new LocalLsExecutor(undefined, ignoreRules(), rootDir, traversal([budgetedName, "overflow.ts"]) as never);
      const result = await executor.execute(createContext(), { path: "." });
      const root = treeOf(result);
      assert.equal(root.childrenFiles.some((file: { name: string }) => file.name === budgetedName), true);
      assert.equal(root.childrenFiles.some((file: { name: string }) => file.name === "overflow.ts"), false);
      assert.equal(root.childrenWereProcessed, false);
      assert.equal(root.fullSubtreeExtensionCounts[".ts"], 1);
      assert.equal(root.numFiles, 1);
    });
  });

  it("reports traversal failures as an error, but keeps a missing traversal binding distinct", async () => {
    await withRoot(async (rootDir) => {
      const failedWalk = traversal([]) as any;
      failedWalk.walk = () => { throw new Error("traversal unavailable"); };
      const failed = await new LocalLsExecutor(undefined, ignoreRules(), rootDir, failedWalk).execute(createContext(), { path: "." });
      assert.equal(failed.kind, "error");
      if (failed.kind !== "error") assert.fail("expected an ls error");
      assert.equal(failed.error, "traversal unavailable");
      await assert.rejects(
        () => new LocalLsExecutor(undefined, ignoreRules(), rootDir).execute(createContext(), { path: "." }),
        MissingLsTraversalBindingError,
      );
    });
  });

  it("keeps directories and files sorted and counts every omitted descendant by extension", async () => {
    await withRoot(async (rootDir) => {
      const run = traversal(["b-dir/c.md", "a-dir/b.ts", "a-dir/a.ts", "a-dir/c.ts", "b-dir/a.md", "c-dir/x.ts"]);
      const result = await new LocalLsExecutor(undefined, ignoreRules(), rootDir, run as never).execute(createContext(), { path: "." });
      const root = treeOf(result);
      assert.deepEqual(root.childrenDirs.map((node: { absPath: string }) => basename(node.absPath)), ["a-dir", "b-dir", "c-dir"]);
      assert.deepEqual(root.childrenDirs.map((node) => node.childrenFiles.map((file) => file.name)), [["a.ts", "b.ts", "c.ts"], ["a.md", "c.md"], ["x.ts"]]);
      assert.equal(root.childrenWereProcessed, true);
    });
  });
});
