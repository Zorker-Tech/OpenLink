/**
 * The operating system's error code behind a failure.
 *
 * A failure may be wrapped more than once on its way up, so the chain is walked — without looping forever on a cycle —
 * to find the code the system actually reported, which is what tells a caller that a file is missing rather than that
 * something went wrong.
 */
export function findSystemErrno(error: unknown): string | undefined {
  const seen = new Set<object>();
  let current = error;
  while (current != null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^E[A-Z_]+$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
