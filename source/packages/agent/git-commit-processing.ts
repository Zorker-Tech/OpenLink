
/**
 * The commits the user attached, with their diffs.
 *
 * A commit's diff is the useful part and also the part that can be enormous — a dependency bump or a
 * generated file can be hundreds of thousands of characters — so each commit is given a budget of its
 * own and the diff is cut to fit, with a notice that says it was cut and how to see the rest. The budget
 * is shared with the header: a commit with a long message has less room for its diff, which is the right
 * trade because the message is short enough to matter.
 */

const PROMPT_BUDGET_PER_COMMIT = 8_000
const CHARS_PER_ESTIMATED_TOKEN = 4
const MAX_COMMIT_CONTEXT_CHARS = PROMPT_BUDGET_PER_COMMIT * CHARS_PER_ESTIMATED_TOKEN
const PATCH_CUT_NOTICE =
  "\n\n[commit diff truncated due to size; run `git show <sha>` locally for the full output]"

interface TextContent {
  readonly type: "text"
  readonly text: string
}

/** Fields Slate needs after the external selected-context message has been decoded. */
export interface AttachedGitCommit {
  readonly objectId: string
  readonly subject: string
  readonly explanation?: string | undefined
  readonly patch: string
}

export function buildGitCommitsUserContent(gitCommits: readonly AttachedGitCommit[]): TextContent {
  if (gitCommits.length === 0) return { type: "text", text: "" }
  const formattedCommits = gitCommits.map(formatCommitForPrompt).join("\n\n")
  const text = [
    "<git_commits>",
    `The following git commit${gitCommits.length > 1 ? "s have" : " has"} been manually attached:`,
    "",
    formattedCommits,
    "</git_commits>",
  ].join("\n")
  return { type: "text", text }
}

function formatCommitForPrompt(commit: AttachedGitCommit): string {
  const headerLength = `Commit: ${commit.objectId}\nMessage: ${commit.subject}\n`.length +
    (commit.explanation ? `Description:\n${commit.explanation}\n`.length : 0) +
    "\nDiff:\n".length
  const patchBudget = Math.max(0, MAX_COMMIT_CONTEXT_CHARS - headerLength)
  const patchText = limitPatch(commit.patch, patchBudget)
  const parts = [`Commit: ${commit.objectId}`, `Message: ${commit.subject}`]
  if (commit.explanation?.trim()) parts.push(`Description:\n${commit.explanation}`)
  if (patchText) parts.push(`\nDiff:\n${patchText}`)
  return parts.join("\n")
}

function limitPatch(patch: string, availableChars: number): string {
  if (patch.length <= availableChars) return patch
  return patch.slice(0, availableChars - PATCH_CUT_NOTICE.length) + PATCH_CUT_NOTICE
}
