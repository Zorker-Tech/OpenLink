import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

import { resolveWorkerLocation } from "../../source/packages/agent/tools/core/worker-script-location.ts";

const roots: string[] = [];
/** A module directory holding these files, as the URL a module would be loaded from. */
function moduleWith(files: readonly string[]): { readonly dir: string; readonly url: string } {
  const dir = mkdtempSync(join(tmpdir(), "slate-worker-"));
  roots.push(dir);
  for (const file of files) writeFileSync(join(dir, file), "x");
  return { dir, url: pathToFileURL(join(dir, "module.ts")).href };
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("where the worker scripts are", () => {
  it("is beside the module when the worker was written beside it", () => {
    const { dir, url } = moduleWith(["worker.ts"]);
    assert.deepEqual(resolveWorkerLocation(url, "worker"), { dir, extension: "ts" });
  });

  it("takes the extension the file actually has, and prefers the source one", () => {
    const built = moduleWith(["worker.js"]);
    assert.deepEqual(resolveWorkerLocation(built.url, "worker"), { dir: built.dir, extension: "js" });
    const both = moduleWith(["worker.ts", "worker.js"]);
    assert.deepEqual(resolveWorkerLocation(both.url, "worker"), { dir: both.dir, extension: "ts" });
  });

  it("is beside the entry point when the module's own directory has none", () => {
    const moduleDir = moduleWith([]);
    const entryDir = mkdtempSync(join(tmpdir(), "slate-entry-"));
    roots.push(entryDir);
    writeFileSync(join(entryDir, "worker.js"), "x");
    const before = process.argv[1] ?? "";
    process.argv[1] = join(entryDir, "main.js");
    try {
      assert.deepEqual(resolveWorkerLocation(moduleDir.url, "worker"), { dir: entryDir, extension: "js" });
    } finally {
      process.argv[1] = before;
    }
  });

  it("is the module's own directory when the worker is nowhere, so the caller has a path to name", () => {
    const { dir, url } = moduleWith(["other.ts"]);
    assert.deepEqual(resolveWorkerLocation(url, "worker"), { dir, extension: "js" });
  });
});
