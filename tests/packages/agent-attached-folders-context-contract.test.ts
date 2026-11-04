import assert from "node:assert/strict"
import { test } from "node:test"

import { renderAttachedFoldersContext } from "../../source/packages/agent/context/attached-folders-context.ts"

function directory(absPath: string, fileName: string) {
  return {
    absPath,
    childrenWereProcessed: true,
    childrenFiles: [{ name: fileName }],
    childrenDirs: [],
    numFiles: 1,
    fullSubtreeExtensionCounts: { ts: 1 },
  }
}

test("missing and malformed directory trees do not create empty folder entries", () => {
  const result = renderAttachedFoldersContext([
    { path: "/missing" },
    { path: "/wrong-shape", directoryTree: "not a directory tree" },
    { path: "/partial", directoryTree: { absPath: "/partial", childrenFiles: [], childrenDirs: null } },
  ])

  assert.equal(result, undefined)
})

test("valid folder trees keep selection order while malformed entries are skipped", () => {
  const result = renderAttachedFoldersContext([
    { path: "/first", directoryTree: directory("/first", "one.ts") },
    { path: "/broken", directoryTree: { absPath: "/broken", childrenFiles: [], childrenDirs: null } },
    { path: "/last", directoryTree: directory("/last", "two.ts") },
  ])

  assert.match(result!, /Here are some folders I manually attached/)
  assert.match(result!, /Folder: \/first[\s\S]*Folder: \/last/)
  assert.match(result!, /- one\.ts[\s\S]*- two\.ts/)
  assert.doesNotMatch(result!, /Folder: \/broken/)
})
