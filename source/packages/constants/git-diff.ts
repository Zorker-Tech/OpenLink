/**
 * The diff the platform attaches to a prompt.
 *
 * A diff is attached for context, not to be complete: it is cut off at a character budget derived from a token
 * estimate, and the notice left behind says so, so the model does not conclude that the repository ends where the
 * diff does. The words the prompt carries come first, then the budget they are cut at.
 */

/** How an uncommitted diff is introduced in the prompt. */
export const GIT_DIFF_UNCOMMITTED_INTRO = "Workspace changes not yet committed:\n\n";

/** How the branch diff is introduced in the prompt. */
export const GIT_DIFF_INTRO = "Changes between this branch and the default branch:\n\n";

/** What is left behind when a diff was cut, so the model knows the diff is not the repository. */
export const GIT_DIFF_TRUNCATION_NOTICE = "\n\n[diff truncated to fit the context; inspect the repository diff for the complete change]";

/** The approximate token budget a diff may take in a prompt. */
export const GIT_DIFF_APPROXIMATE_MAX_TOKENS = 10_000;

/** How many characters this platform counts per token, for the budget above. */
export const GIT_DIFF_CHARS_PER_TOKEN = 4;

/** The characters a token budget amounts to at this platform estimate. */
function charactersFor(tokens: number): number {
  return tokens * GIT_DIFF_CHARS_PER_TOKEN;
}

/** The character budget a diff is cut at. */
export const MAX_GIT_DIFF_CHAR_LENGTH = charactersFor(GIT_DIFF_APPROXIMATE_MAX_TOKENS);
