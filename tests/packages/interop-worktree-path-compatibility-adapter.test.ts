import assert from "node:assert/strict";
import { test } from "node:test";

import { adaptLegacyWorktreePath } from "../../source/adapters/interop/workspace/legacy-worktree-path-adapter.ts";

test("the legacy workspace spelling is corrected only at its known path boundary", () => {
  assert.equal(adaptLegacyWorktreePath("/Users/u/.cursor/worktries/repo"), "/Users/u/.cursor/worktrees/repo");
  assert.equal(adaptLegacyWorktreePath("/home/u/.cursor/worktries"), "/home/u/.cursor/worktrees");
  assert.equal(adaptLegacyWorktreePath("/Users/u/.cursor/worktrees/repo"), "/Users/u/.cursor/worktrees/repo");
  assert.equal(adaptLegacyWorktreePath("/Users/u/.cursor/worktries-extra/repo"), "/Users/u/.cursor/worktries-extra/repo");
  assert.equal(adaptLegacyWorktreePath("/srv/worktries/repo"), "/srv/worktries/repo");
  assert.equal(adaptLegacyWorktreePath("C:\\Users\\u\\.cursor\\worktries\\repo"), "C:\\Users\\u\\.cursor\\worktries\\repo");
});
