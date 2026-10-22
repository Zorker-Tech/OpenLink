/**
 * The markers that say what a hidden prompt was for.
 *
 * A prompt the user does not see still carries why it was sent, as one bracketed word at its start; the runner reads
 * that word back out when it reads the conversation. The words are the format: they travel between the host and the
 * screens, so they are kept as they are written rather than built up.
 */

/** The marker a prompt carries when it is hidden from the conversation. */
export const SLATE_HIDDEN_PROMPT_MARKER = "[SLATE_HIDDEN_PROMPT]";

/** The marker a prompt carries when it was sent by trusted automation. */
export const SLATE_TRUSTED_AUTOMATION_PROMPT_MARKER = "[SLATE_TRUSTED_AUTOMATION_PROMPT]";
