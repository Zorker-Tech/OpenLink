import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { test } from "node:test"

import {
  containWithin,
  filePathFromFileUrl,
  isPathWithin,
  posixPathFromFileUrl,
  realpathNearestExisting,
} from "../../source/shared/node/paths.ts"

test("path containment resolves dot segments and treats the root itself explicitly", () => {
  const root = resolve("/tmp/slate-root")
  assert.equal(isPathWithin(root, join(root, "nested", "..", "file")), true)
  assert.equal(isPathWithin(root, root), false)
  assert.equal(isPathWithin(root, root, { isInclusive: true }), true)
  assert.equal(isPathWithin(root, `${root}-sibling/file`), false)
})

test("file URLs are converted only when valid and keep their path spelling", () => {
  const file = "/tmp/slate report.json"
  const url = pathToFileURL(file).toString()
  assert.equal(filePathFromFileUrl(url), file)
  assert.equal(posixPathFromFileUrl(url), "/tmp/slate report.json")
  assert.equal(filePathFromFileUrl("https://example.test/file"), null)
  assert.equal(posixPathFromFileUrl("https://example.test/file"), null)
  assert.equal(filePathFromFileUrl("not a url"), null)
})

test("containment resolves existing symlinks and allows a not-yet-created suffix under an allowed root", async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "slate-path-boundary-"))
  const allowed = join(temporaryRoot, "allowed")
  const outside = join(temporaryRoot, "outside")
  try {
    mkdirSync(allowed)
    mkdirSync(outside)
    writeFileSync(join(allowed, "visible.txt"), "ok")
    symlinkSync(outside, join(allowed, "escape"), "dir")

    assert.equal(await containWithin([allowed], join(allowed, "visible.txt")), join(allowed, "visible.txt"))
    assert.equal(await containWithin([allowed], join(allowed, "new", "nested.txt")), join(allowed, "new", "nested.txt"))
    assert.equal(await containWithin([allowed], join(allowed, "escape", "outside.txt")), null)
    assert.equal(await containWithin([allowed], "relative/file"), null)
    assert.equal(await containWithin([], join(allowed, "visible.txt")), null)
    assert.equal(await realpathNearestExisting(join(allowed, "new", "nested.txt")), join(realpathSync(allowed), "new", "nested.txt"))
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
})
