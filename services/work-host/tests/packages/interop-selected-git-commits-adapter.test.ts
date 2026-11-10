import assert from "node:assert/strict"
import test from "node:test"
import { SelectedGitCommit } from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import { toAttachedGitCommits } from "../../source/adapters/interop/agent/selected-git-commits-adapter.ts"

test("selected commits are translated into Slate's prompt fields in order", () => {
  const commits = [
    new SelectedGitCommit({ sha: "8a1", message: "Add the index", description: "Avoid rescanning", diff: "+index" }),
    new SelectedGitCommit({ sha: "8a2", message: "Keep the fallback", diff: "-throw" }),
  ]

  assert.deepEqual(toAttachedGitCommits(commits), [
    { objectId: "8a1", subject: "Add the index", explanation: "Avoid rescanning", patch: "+index" },
    { objectId: "8a2", subject: "Keep the fallback", explanation: undefined, patch: "-throw" },
  ])
})
