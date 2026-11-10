/**
 * The operating system's error code behind a failure.
 *
 * A failure may be wrapped more than once on its way up, so the chain is walked — without looping forever on a cycle —
 * to find the code the system actually reported, which is what tells a caller that a file is missing rather than that
 * something went wrong.
 */

/** The shape of a system error code: an E, then upper-case letters and underscores. */
const SYSTEM_ERRNO_PATTERN = /^E[A-Z_]+$/;

/** The code this wrapper carries, when it carries one that looks like the system's. */
function systemErrnoOf(wrapper: object): string | undefined {
  const code = (wrapper as { code?: unknown }).code;
  return typeof code === "string" && SYSTEM_ERRNO_PATTERN.test(code) ? code : undefined;
}

/** Whether this is a wrapper the walk has not opened yet. */
function isUnopenedWrapper(value: unknown, walked: Set<object>): value is object {
  return value != null && typeof value === "object" && !walked.has(value);
}

/** The system's code behind this failure, looking through every wrapper it came up in. */
export function findSystemErrno(error: unknown): string | undefined {
  const walked = new Set<object>();
  let current: unknown = error;
  while (isUnopenedWrapper(current, walked)) {
    walked.add(current);
    const code = systemErrnoOf(current);
    if (code !== undefined) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
