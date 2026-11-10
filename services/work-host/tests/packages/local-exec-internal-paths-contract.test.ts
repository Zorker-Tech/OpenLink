import assert from "node:assert/strict"
import { homedir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { SLATE_PROJECTS_ROOT, SLATE_WORKTREES_ROOT } from "../../source/packages/local-exec/internal-paths.ts"

test("managed project and worktree roots are separate Slate directories under the home directory", () => {
  const slateRoot = join(homedir(), ".slate")
  assert.equal(SLATE_PROJECTS_ROOT, join(slateRoot, "projects"))
  assert.equal(SLATE_WORKTREES_ROOT, join(slateRoot, "worktrees"))
  assert.notEqual(SLATE_PROJECTS_ROOT, SLATE_WORKTREES_ROOT)
})
