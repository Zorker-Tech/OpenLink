import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { test } from "node:test"

import { isPathWithin, resolvePath, resolveRealPathStrict, shouldBlockWorktreePath } from "../../source/packages/utils/paths.ts"

test("file URLs and symlink prefixes resolve to their real location", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "slate-path-boundary-"))
  const target = path.join(directory, "real folder")
  const alias = path.join(directory, "alias")
  try {
    mkdirSync(target)
    symlinkSync(target, alias)
    const file = path.join(target, "new note.txt")
    assert.equal(resolvePath(pathToFileURL(file).href), file)
    assert.equal(await resolveRealPathStrict(path.join(alias, "new note.txt")), path.join(realpathSync(target), "new note.txt"))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("worktree protection blocks sibling or main checkouts but keeps unrelated paths available", () => {
  const checkout = "/repo/.slate/worktrees/project/feature"
  assert.equal(shouldBlockWorktreePath({ targetPath: "../other", workspacePaths: [checkout] }), true)
  assert.equal(shouldBlockWorktreePath({ targetPath: "/repo/.slate/worktrees/project/other", workspacePaths: [checkout] }), true)
  assert.equal(shouldBlockWorktreePath({ targetPath: "/repo/src/file.ts", workspacePaths: [checkout], mainWorktreePath: "/repo" }), true)
  assert.equal(shouldBlockWorktreePath({ targetPath: "../../../../outside", workspacePaths: [checkout] }), false)
  assert.equal(shouldBlockWorktreePath({ targetPath: "/repo/.slate/worktrees/project/other", workspacePaths: [checkout, "/repo/src"] }), false)
  assert.equal(isPathWithin({ basePath: "/repo", targetPath: "/repository/file.ts" }), false)
})
