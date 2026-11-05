import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectSelectedNonMediaContext } from "../../source/adapters/interop/agent/selected-non-media-context-adapter.ts";
import {
  SelectedContext,
  SelectedCursorCommand,
  SelectedGitCommit,
  SelectedGitDiff,
  SelectedGitDiffFromBranchToMain,
} from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts";

describe("selected non-media context projection", () => {
  it("copies only Slate-owned command, diff and commit fields needed by the assembler", () => {
    const source = new SelectedContext({
      cursorCommands: [new SelectedCursorCommand({ name: "read", content: "cat", fullPath: "/repo/.slate/commands/read.md" })],
      gitDiff: new SelectedGitDiff({ content: "work diff", fullContentLengthCharCount: 9 }),
      gitDiffFromBranchToMain: new SelectedGitDiffFromBranchToMain({ content: "branch diff", fullContentLengthCharCount: 11 }),
      gitCommits: [new SelectedGitCommit({ sha: "abc", message: "subject", description: "detail", diff: "patch" })],
    });

    const projected = projectSelectedNonMediaContext(source);
    assert.deepEqual(projected, {
      attachedCommands: [{ name: "read", content: "cat", sourcePath: "/repo/.slate/commands/read.md" }],
      gitDiff: { content: "work diff", fullContentLengthCharCount: 9 },
      gitDiffFromBranchToMain: { content: "branch diff", fullContentLengthCharCount: 11 },
      gitCommits: [{ objectId: "abc", subject: "subject", explanation: "detail", patch: "patch" }],
    });
    assert.equal("fullPath" in (projected.attachedCommands[0] as object), false);
  });

  it("projects an empty wire selection as empty Slate-owned collections", () => {
    assert.deepEqual(projectSelectedNonMediaContext(new SelectedContext()), {
      attachedCommands: [],
      gitDiff: undefined,
      gitDiffFromBranchToMain: undefined,
      gitCommits: [],
    });
  });
});
