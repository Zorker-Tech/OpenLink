/** The sizes the local executor works within: one buffer, and one output file. */

/** The size of one buffer the executor reads or writes at a time: one mebibyte. */
export const MAX_BUFFER_SIZE = 1_048_576;

/** The largest output file the executor writes for one shell run: fifty mebibytes. */
export const MAX_OFS_FILE_SIZE = 50 * 1024 * 1024;
