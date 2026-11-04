import type { SelectedGitCommit } from "../proto/generated/agent/v1/selected_context_pb.ts"
import type { AttachedGitCommit } from "../../../packages/agent/git-commit-processing.ts"

/** Translate the counterpart's selected-commit fields into the context Slate uses to build a prompt. */
export function toAttachedGitCommits(commits: readonly SelectedGitCommit[]): AttachedGitCommit[] {
  return commits.map(commit => ({
    objectId: commit.sha,
    subject: commit.message,
    explanation: commit.description,
    patch: commit.diff,
  }))
}
