import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createContext } from "../../source/packages/context/context.ts";
import { LocalDirectoryTraversal } from "../../source/packages/local-exec/directory-traversal.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "slate-directory-traversal-"));
  roots.push(root);
  return root;
}

async function linesOf(iterable: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of iterable) lines.push(line);
  return lines;
}

describe("Slate directory traversal", () => {
  it("lists files deterministically and skips configured directories", async () => {
    const root = workspace();
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "src", "b.ts"), "");
    writeFileSync(join(root, "src", "a.ts"), "");
    writeFileSync(join(root, "README.md"), "");
    writeFileSync(join(root, "dist", "bundle.js"), "");
    const traversal = new LocalDirectoryTraversal(root);

    const walked = traversal.walk(createContext(), {
      root,
      excludeGlobs: ["dist"],
      cursorIgnoreFiles: [],
      source: "ls",
    });
    assert.deepEqual(await linesOf(walked.lines), ["README.md", "src/a.ts", "src/b.ts"]);
    assert.equal(await walked.didTimeout, false);
  });

  it("resolves ordinary paths and refuses links that escape the workspace", async () => {
    const root = workspace();
    const outside = workspace();
    writeFileSync(join(root, "inside.txt"), "");
    writeFileSync(join(outside, "outside.txt"), "");
    symlinkSync(join(outside, "outside.txt"), join(root, "outside-link.txt"));
    const traversal = new LocalDirectoryTraversal(root);

    assert.equal(await traversal.resolveForIgnore(join(root, "inside.txt")), await realpath(join(root, "inside.txt")));
    assert.equal(await traversal.resolveForIgnore(join(root, "outside-link.txt")), null);
  });

  it("resolves a workspace that appears after the traversal is constructed", async () => {
    const root = workspace();
    rmSync(root, { recursive: true, force: true });
    const traversal = new LocalDirectoryTraversal(root);
    mkdirSync(root);
    const file = join(root, "created-later.txt");
    writeFileSync(file, "");

    assert.equal(await traversal.resolveForIgnore(file), await realpath(file));
  });

  it("finishes promptly when its context is cancelled", async () => {
    const root = workspace();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "");
    const [context, cancel] = createContext().withCancel();
    cancel("stop");
    const traversal = new LocalDirectoryTraversal(root);
    const walked = traversal.walk(context, {
      root,
      excludeGlobs: [],
      cursorIgnoreFiles: [],
      source: "ls",
    });

    assert.deepEqual(await linesOf(walked.lines), []);
    assert.equal(await walked.didTimeout, true);
  });
});
