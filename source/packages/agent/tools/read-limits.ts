/**
 * How much of a file the read tool will hand back.
 *
 * The hard limit is the platform's own cap on any tool output, reused here so a read and a shell command
 * cannot disagree about what is too much. The threshold is separate and lower: above it a file is worth
 * spilling to a blob rather than carrying in the conversation, because the model rarely needs all of it
 * and the conversation carries it forever.
 */

import { CHAR_HARD_LIMIT } from "./tool-support.ts"

export const READ_CHAR_HARD_LIMIT = CHAR_HARD_LIMIT
export const LARGE_TEXT_BLOB_THRESHOLD = 10_000
