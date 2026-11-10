import {
  DIFF_NO_BUDGET_MESSAGE,
  formatParsedDiffWithTruncation,
} from "./diff-processing.ts"
import type { ParsedDiffBlocks, SelectedGitDiffAttachment, UserTextBlock } from "./git-diff-attachment-contracts.ts"
import { splitDiffAtPathBoundaries } from "./git-diff-file-blocks.ts"
import {
  GIT_DIFF_INTRO,
  GIT_DIFF_TRUNCATION_NOTICE,
  GIT_DIFF_UNCOMMITTED_INTRO,
  MAX_GIT_DIFF_CHAR_LENGTH,
} from "../constants/git-diff.ts"

interface AttachmentEnvelope {
  readonly tag: string
  readonly introduction: string
}

const WORKTREE_ENVELOPE: AttachmentEnvelope = {
  tag: "git_diff",
  introduction: GIT_DIFF_UNCOMMITTED_INTRO,
}

const BRANCH_ENVELOPE: AttachmentEnvelope = {
  tag: "git_diff_from_branch_to_main",
  introduction: GIT_DIFF_INTRO,
}

function boundDiffText(diffText: string, maxCharacters: number): string {
  if (maxCharacters <= 0) return DIFF_NO_BUDGET_MESSAGE
  if (diffText.length <= maxCharacters) return diffText

  const sections: ParsedDiffBlocks = splitDiffAtPathBoundaries(diffText)
  return formatParsedDiffWithTruncation(sections, maxCharacters, {
    originalContent: diffText,
    truncationNotice: GIT_DIFF_TRUNCATION_NOTICE,
  })
}

function envelopeDiff(
  selected: SelectedGitDiffAttachment,
  envelope: AttachmentEnvelope,
): UserTextBlock {
  let body = selected.content ?? ""
  let incomplete = selected.fullContentLengthCharCount > body.length

  if (body.length > MAX_GIT_DIFF_CHAR_LENGTH) {
    body = boundDiffText(body, MAX_GIT_DIFF_CHAR_LENGTH)
    incomplete = true
  }
  if (incomplete && !body.endsWith(GIT_DIFF_TRUNCATION_NOTICE)) {
    body += GIT_DIFF_TRUNCATION_NOTICE
  }

  return {
    type: "text",
    text: [`<${envelope.tag}>`, `  ${envelope.introduction}${body}`, `  </${envelope.tag}>`].join("\n"),
  }
}

export function buildWorktreeChangeAttachment(selected: SelectedGitDiffAttachment): UserTextBlock {
  return envelopeDiff(selected, WORKTREE_ENVELOPE)
}

export function buildBranchChangeAttachment(selected: SelectedGitDiffAttachment): UserTextBlock {
  return envelopeDiff(selected, BRANCH_ENVELOPE)
}

// Keep the established entry points available while the host call sites move to Slate's attachment vocabulary.
export const buildGitDiffUncommittedUserContent = buildWorktreeChangeAttachment
export const buildGitDiffUserContent = buildBranchChangeAttachment
